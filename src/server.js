import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query } from './db.js';
import { clearAuthCookie, requireAdmin, setAuthCookie, signToken, verifyPassword } from './auth.js';
import { deleteImage, saveImage } from './storage.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const origins = (process.env.FRONTEND_ORIGINS || 'https://happinesschildrenshome.co.ke,https://www.happinesschildrenshome.co.ke,http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const maxImageSize = 10 * 1024 * 1024;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(Object.assign(new Error('This website origin is not allowed by FRONTEND_ORIGINS.'), { status: 403 }));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please wait a few minutes.' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many messages. Please try again later.' } });
const donorLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Please wait before submitting another registration.' } });
const trafficLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageSize, files: 1, fields: 8, parts: 10 },
  fileFilter(_req, file, callback) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(Object.assign(new Error('Choose a JPEG, PNG or WebP image.'), { status: 400 }));
    }
    callback(null, true);
  },
});

app.use('/api/admin', (_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
});

const idParam = z.object({ id: z.string().uuid() });
const galleryFields = z.object({
  title: z.string().trim().min(1).max(140),
  altText: z.string().trim().min(1).max(250),
  category: z.string().trim().min(1).max(60),
});
const eventFields = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().min(1).max(3000),
  startsAt: z.string().datetime({ offset: true }),
  location: z.string().trim().max(240).optional().default(''),
  category: z.string().trim().max(60).optional().default('Community'),
  registrationUrl: z.union([z.string().url().max(1000), z.literal('')]).optional().default(''),
  published: z.preprocess((value) => {
    if (value === undefined) return true;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  }, z.boolean()),
});
const contactSchema = z.object({
  name: z.string().trim().min(2).max(140),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(32).optional().default(''),
  subject: z.string().trim().max(140).optional().default('General enquiry'),
  message: z.string().trim().min(5).max(5000),
  preferredContact: z.enum(['email', 'phone', 'whatsapp']).optional().default('email'),
  website: z.string().max(200).optional().default(''),
});
const donorSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^[+0-9().\s-]{7,32}$/, 'Enter a valid international phone number.'),
  country: z.string().trim().min(2).max(100),
  interests: z.string().trim().max(80).optional().default('General support'),
  consent: z.literal(true),
});
const statusSchema = z.object({ status: z.enum(['new', 'read', 'replied']) });
const reminderSchema = z.object({ channel: z.enum(['email', 'whatsapp']), message: z.string().trim().min(2).max(1200) });
const trafficSchema = z.object({ path: z.string().trim().min(1).max(200).refine((path) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/admin'), 'Invalid page path.') });
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error(result.error.issues[0]?.message || 'Invalid input.'), { status: 400 });
  return result.data;
};
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const noPublicCache = (_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
};
async function deleteImageQuietly(storageKey) {
  if (!storageKey) return;
  try { await deleteImage(storageKey); }
  catch (error) { console.error('Could not remove old R2 image:', error); }
}

app.get('/health', (_req, res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).json({ ok: true }));

app.get('/api/gallery', noPublicCache, asyncRoute(async (_req, res) => {
  const { rows } = await query('SELECT id,title,alt_text AS "altText",category,image_url AS "imageUrl",created_at AS "createdAt" FROM gallery_photos ORDER BY sort_order ASC, created_at DESC');
  res.json(rows);
}));
app.post('/api/traffic', noPublicCache, trafficLimiter, asyncRoute(async (req, res) => {
  const { path } = parse(trafficSchema, req.body);
  await query('INSERT INTO site_page_views(path) VALUES($1)', [path]);
  res.status(202).json({ ok: true });
}));
app.get('/api/events', noPublicCache, asyncRoute(async (_req, res) => {
  const { rows } = await query("SELECT id,title,description,starts_at AS \"startsAt\",location,category,registration_url AS \"registrationUrl\",image_url AS \"imageUrl\" FROM events WHERE published=true AND starts_at >= NOW() - INTERVAL '1 day' ORDER BY starts_at ASC");
  res.json(rows);
}));

app.post('/api/contact', contactLimiter, asyncRoute(async (req, res) => {
  const value = parse(contactSchema, req.body);
  if (value.website) return res.status(201).json({ ok: true });
  await query('INSERT INTO contact_inquiries(name,email,phone,subject,message,preferred_contact) VALUES($1,$2,$3,$4,$5,$6)', [value.name, value.email.toLowerCase(), value.phone, value.subject || 'General enquiry', value.message, value.preferredContact]);
  res.status(201).json({ ok: true });
}));
app.post('/api/donors', donorLimiter, asyncRoute(async (req, res) => {
  const value = parse(donorSchema, req.body);
  await query(`INSERT INTO donors(first_name,last_name,email,phone,country,interests,consent) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,phone=EXCLUDED.phone,country=EXCLUDED.country,interests=EXCLUDED.interests,consent=EXCLUDED.consent,updated_at=NOW()`,
  [value.firstName, value.lastName, value.email.toLowerCase(), value.phone, value.country, value.interests, value.consent]);
  res.status(201).json({ ok: true });
}));

app.post('/api/admin/login', loginLimiter, asyncRoute(async (req, res) => {
  const body = parse(z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }), req.body);
  const user = await verifyPassword(body.email, body.password);
  if (!user) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setAuthCookie(res, signToken(user));
  res.json({ ok: true, user: { email: user.email } });
}));
app.post('/api/admin/logout', (_req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));

app.get('/api/admin/gallery', requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await query('SELECT id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt" FROM gallery_photos ORDER BY sort_order ASC, created_at DESC');
  res.json(rows);
}));
app.post('/api/admin/gallery', requireAdmin, uploadLimiter, imageUpload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('Choose a photo before uploading.'), { status: 400 });
  const value = parse(galleryFields, req.body);
  const saved = await saveImage({ buffer: req.file.buffer, fileName: req.file.originalname, contentType: req.file.mimetype });
  try {
    const { rows } = await query('INSERT INTO gallery_photos(title,alt_text,category,image_url,storage_key) VALUES($1,$2,$3,$4,$5) RETURNING id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt"',
      [value.title, value.altText, value.category, saved.imageUrl, saved.storageKey]);
    res.status(201).json(rows[0]);
  } catch (error) {
    await deleteImageQuietly(saved.storageKey);
    throw error;
  }
}));
app.patch('/api/admin/gallery/:id', requireAdmin, uploadLimiter, imageUpload.single('image'), asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const value = parse(galleryFields, req.body);
  const old = await query('SELECT storage_key FROM gallery_photos WHERE id=$1', [id]);
  if (!old.rowCount) return res.status(404).json({ error: 'Photo not found.' });
  const saved = req.file ? await saveImage({ buffer: req.file.buffer, fileName: req.file.originalname, contentType: req.file.mimetype }) : null;
  try {
    const { rows } = await query('UPDATE gallery_photos SET title=$2,alt_text=$3,category=$4,image_url=COALESCE($5,image_url),storage_key=COALESCE($6,storage_key),updated_at=NOW() WHERE id=$1 RETURNING id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt"',
      [id, value.title, value.altText, value.category, saved?.imageUrl || null, saved?.storageKey || null]);
    if (saved) await deleteImageQuietly(old.rows[0].storage_key);
    res.json(rows[0]);
  } catch (error) {
    if (saved) await deleteImageQuietly(saved.storageKey);
    throw error;
  }
}));
app.delete('/api/admin/gallery/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { rows } = await query('DELETE FROM gallery_photos WHERE id=$1 RETURNING storage_key', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Photo not found.' });
  await deleteImageQuietly(rows[0].storage_key);
  res.json({ ok: true });
}));

app.get('/api/admin/insights', requireAdmin, asyncRoute(async (_req, res) => {
  const [gallery, events, inquiries, unread, donors, recentInquiries, recentDonors, countries] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM gallery_photos'),
    query('SELECT COUNT(*)::int AS count FROM events WHERE published=true AND starts_at>=NOW()'),
    query('SELECT COUNT(*)::int AS count FROM contact_inquiries'),
    query("SELECT COUNT(*)::int AS count FROM contact_inquiries WHERE status='new'"),
    query('SELECT COUNT(*)::int AS count FROM donors'),
    query('SELECT id,name,email,subject,status,created_at AS "createdAt" FROM contact_inquiries ORDER BY created_at DESC LIMIT 5'),
    query('SELECT id,first_name AS "firstName",last_name AS "lastName",country,created_at AS "createdAt" FROM donors ORDER BY created_at DESC LIMIT 5'),
    query('SELECT country,COUNT(*)::int AS count FROM donors GROUP BY country ORDER BY count DESC,country ASC LIMIT 5'),
  ]);
  res.json({ counts: { gallery: gallery.rows[0].count, upcomingEvents: events.rows[0].count, inquiries: inquiries.rows[0].count, unreadInquiries: unread.rows[0].count, donors: donors.rows[0].count }, recentInquiries: recentInquiries.rows, recentDonors: recentDonors.rows, donorsByCountry: countries.rows });
}));
app.get('/api/admin/traffic', requireAdmin, asyncRoute(async (req, res) => {
  const periods = {
    day: { unit: 'hour', offset: '23 hours', step: '1 hour' },
    week: { unit: 'day', offset: '6 days', step: '1 day' },
    month: { unit: 'day', offset: '29 days', step: '1 day' },
    year: { unit: 'month', offset: '11 months', step: '1 month' },
  };
  const period = typeof req.query.period === 'string' ? req.query.period : 'week';
  const window = periods[period];
  if (!window) throw Object.assign(new Error('Choose day, week, month or year.'), { status: 400 });
  const { unit, offset, step } = window;
  const [tracking, chart] = await Promise.all([
    query('SELECT tracking_started_at AS "trackingStartedAt" FROM site_analytics_meta WHERE id=true'),
    query(`WITH buckets AS (
      SELECT generate_series(
        date_trunc('${unit}', NOW()) - INTERVAL '${offset}',
        date_trunc('${unit}', NOW()),
        INTERVAL '${step}'
      ) AS bucket
    ), counts AS (
      SELECT date_trunc('${unit}', viewed_at) AS bucket, COUNT(*)::int AS views
      FROM site_page_views
      WHERE viewed_at >= (SELECT MIN(bucket) FROM buckets)
      GROUP BY 1
    ), tracking AS (
      SELECT tracking_started_at FROM site_analytics_meta WHERE id=true
    )
    SELECT b.bucket,
      CASE WHEN b.bucket < date_trunc('${unit}', t.tracking_started_at) THEN NULL
           ELSE COALESCE(c.views, 0) END AS views
    FROM buckets b CROSS JOIN tracking t
    LEFT JOIN counts c ON c.bucket=b.bucket
    ORDER BY b.bucket ASC`),
  ]);
  const firstBucket = chart.rows[0]?.bucket;
  const pages = firstBucket ? await query(`SELECT path,COUNT(*)::int AS views FROM site_page_views WHERE viewed_at >= $1 GROUP BY path ORDER BY views DESC,path ASC LIMIT 6`, [firstBucket]) : { rows: [] };
  const points = chart.rows.map((row) => ({ bucket: row.bucket, views: row.views }));
  const measured = points.map((point) => point.views).filter((value) => value !== null);
  res.set('Cache-Control', 'no-store').json({
    period,
    trackingStartedAt: tracking.rows[0]?.trackingStartedAt || null,
    totalViews: measured.reduce((total, value) => total + value, 0),
    peakViews: measured.length ? Math.max(...measured) : 0,
    points,
    topPages: pages.rows,
  });
}));
app.get('/api/admin/inquiries', requireAdmin, asyncRoute(async (req, res) => {
  const status = ['new', 'read', 'replied'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await query(`SELECT id,name,email,phone,subject,message,preferred_contact AS "preferredContact",status,created_at AS "createdAt" FROM contact_inquiries ${status ? 'WHERE status=$1' : ''} ORDER BY created_at DESC LIMIT 500`, status ? [status] : []);
  res.json(rows);
}));
app.patch('/api/admin/inquiries/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { status } = parse(statusSchema, req.body);
  const { rows } = await query('UPDATE contact_inquiries SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING id,status', [id, status]);
  if (!rows[0]) return res.status(404).json({ error: 'Message not found.' });
  res.json(rows[0]);
}));
app.delete('/api/admin/inquiries/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { rowCount } = await query('DELETE FROM contact_inquiries WHERE id=$1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
}));
app.get('/api/admin/donors', requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await query(`SELECT d.id,d.first_name AS "firstName",d.last_name AS "lastName",d.email,d.phone,d.country,d.interests,d.created_at AS "createdAt",
    (SELECT MAX(prepared_at) FROM donor_reminders r WHERE r.donor_id=d.id) AS "lastReminderAt" FROM donors d ORDER BY d.created_at DESC LIMIT 1000`);
  res.json(rows);
}));
app.post('/api/admin/donors/:id/reminders', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const value = parse(reminderSchema, req.body);
  const donor = await query('SELECT id FROM donors WHERE id=$1', [id]);
  if (!donor.rowCount) return res.status(404).json({ error: 'Donor not found.' });
  const { rows } = await query('INSERT INTO donor_reminders(donor_id,channel,message) VALUES($1,$2,$3) RETURNING id,channel,message,prepared_at AS "preparedAt"', [id, value.channel, value.message]);
  res.status(201).json(rows[0]);
}));
app.delete('/api/admin/donors/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { rowCount } = await query('DELETE FROM donors WHERE id=$1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Donor not found.' });
  res.json({ ok: true });
}));

app.get('/api/admin/events', requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await query('SELECT id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",storage_key AS "storageKey",published,created_at AS "createdAt" FROM events ORDER BY starts_at DESC');
  res.json(rows);
}));
app.post('/api/admin/events', requireAdmin, uploadLimiter, imageUpload.single('image'), asyncRoute(async (req, res) => {
  const value = parse(eventFields, req.body);
  const saved = req.file ? await saveImage({ buffer: req.file.buffer, fileName: req.file.originalname, contentType: req.file.mimetype }) : null;
  try {
    const { rows } = await query('INSERT INTO events(title,description,starts_at,location,category,registration_url,image_url,storage_key,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",storage_key AS "storageKey",published,created_at AS "createdAt"',
      [value.title, value.description, value.startsAt, value.location, value.category, value.registrationUrl, saved?.imageUrl || '', saved?.storageKey || null, value.published]);
    res.status(201).json(rows[0]);
  } catch (error) {
    if (saved) await deleteImageQuietly(saved.storageKey);
    throw error;
  }
}));
app.patch('/api/admin/events/:id', requireAdmin, uploadLimiter, imageUpload.single('image'), asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const value = parse(eventFields, req.body);
  const old = await query('SELECT storage_key FROM events WHERE id=$1', [id]);
  if (!old.rowCount) return res.status(404).json({ error: 'Event not found.' });
  const saved = req.file ? await saveImage({ buffer: req.file.buffer, fileName: req.file.originalname, contentType: req.file.mimetype }) : null;
  try {
    const { rows } = await query('UPDATE events SET title=$2,description=$3,starts_at=$4,location=$5,category=$6,registration_url=$7,image_url=COALESCE($8,image_url),storage_key=COALESCE($9,storage_key),published=$10,updated_at=NOW() WHERE id=$1 RETURNING id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",storage_key AS "storageKey",published,created_at AS "createdAt"',
      [id, value.title, value.description, value.startsAt, value.location, value.category, value.registrationUrl, saved?.imageUrl || null, saved?.storageKey || null, value.published]);
    if (saved) await deleteImageQuietly(old.rows[0].storage_key);
    res.json(rows[0]);
  } catch (error) {
    if (saved) await deleteImageQuietly(saved.storageKey);
    throw error;
  }
}));
app.delete('/api/admin/events/:id', requireAdmin, asyncRoute(async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { rows } = await query('DELETE FROM events WHERE id=$1 RETURNING storage_key', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
  await deleteImageQuietly(rows[0].storage_key);
  res.json({ ok: true });
}));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Images must be 10 MB or smaller.' : 'The image upload was incomplete. Please select one image and try again.';
    return res.status(400).json({ error: message });
  }
  console.error(error);
  const status = error.status || 500;
  const message = error.safeMessage || (status < 500 ? error.message : 'The server could not complete that request. Check the backend logs for details.');
  res.status(status).json({ error: message });
});

app.listen(port, '0.0.0.0', () => console.log(`Happiness API listening on ${port}`));
