import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query } from './db.js';
import { clearAuthCookie, requireAdmin, setAuthCookie, signToken, verifyPassword } from './auth.js';
import { deleteImage, signImageUpload } from './storage.js';

const app=express();const port=Number(process.env.PORT||4000);
const origins=(process.env.FRONTEND_ORIGINS||'http://localhost:5173').split(',').map(s=>s.trim()).filter(Boolean);
app.set('trust proxy',1);app.disable('x-powered-by');app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'},contentSecurityPolicy:false}));
app.use(cors({origin(origin,cb){if(!origin||origins.includes(origin))return cb(null,true);return cb(new Error('Origin is not allowed.'));},credentials:true,methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type']}));
app.use(express.json({limit:'32kb'}));app.use(cookieParser());
const loginLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many sign-in attempts. Please wait a few minutes.'}});
const uploadLimiter=rateLimit({windowMs:60*60*1000,limit:60,standardHeaders:'draft-7',legacyHeaders:false});
const contactLimiter=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many messages. Please try again later.'}});
const donorLimiter=rateLimit({windowMs:60*60*1000,limit:6,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Please wait before submitting another registration.'}});
app.use('/api/admin',(_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'});next()});
const idParam=z.object({id:z.string().uuid()});
const gallerySchema=z.object({title:z.string().trim().min(1).max(140),altText:z.string().trim().min(1).max(250),category:z.string().trim().min(1).max(60),imageUrl:z.string().url().max(1000),storageKey:z.string().min(1).max(500)});
const eventSchema=z.object({title:z.string().trim().min(1).max(140),description:z.string().trim().min(1).max(3000),startsAt:z.string().datetime({offset:true}),location:z.string().trim().max(240).optional().default(''),category:z.string().trim().max(60).optional().default('Community'),registrationUrl:z.union([z.string().url().max(1000),z.literal('')]).optional().default(''),imageUrl:z.union([z.string().url().max(1000),z.literal('')]).optional().default(''),published:z.boolean().optional().default(true)});
const contactSchema=z.object({name:z.string().trim().min(2).max(140),email:z.string().trim().email().max(254),phone:z.string().trim().max(32).optional().default(''),subject:z.string().trim().max(140).optional().default('General enquiry'),message:z.string().trim().min(5).max(5000),preferredContact:z.enum(['email','phone','whatsapp']).optional().default('email'),website:z.string().max(200).optional().default('')});
const donorSchema=z.object({firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),email:z.string().trim().email().max(254),phone:z.string().trim().regex(/^[+0-9().\s-]{7,32}$/,'Enter a valid international phone number.'),country:z.string().trim().min(2).max(100),interests:z.string().trim().max(80).optional().default('General support'),consent:z.literal(true)});
const statusSchema=z.object({status:z.enum(['new','read','replied'])});
const reminderSchema=z.object({channel:z.enum(['email','whatsapp']),message:z.string().trim().min(2).max(1200)});
const parse=(schema,input)=>{const out=schema.safeParse(input);if(!out.success)throw Object.assign(new Error(out.error.issues[0]?.message||'Invalid input'),{status:400});return out.data};
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const publicContentCache=(_req,res,next)=>{res.set('Cache-Control','public, max-age=30, s-maxage=60, stale-while-revalidate=180');next();};
app.get('/health',(_req,res)=>res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}).json({ok:true}));
app.get('/api/gallery',publicContentCache,asyncRoute(async(_req,res)=>{const {rows}=await query('SELECT id,title,alt_text AS "altText",category,image_url AS "imageUrl",created_at AS "createdAt" FROM gallery_photos ORDER BY sort_order ASC, created_at DESC');res.json(rows)}));
app.get('/api/events',publicContentCache,asyncRoute(async(_req,res)=>{const {rows}=await query(`SELECT id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl" FROM events WHERE published=true AND starts_at >= NOW() - INTERVAL '1 day' ORDER BY starts_at ASC`);res.json(rows)}));
app.post('/api/contact',contactLimiter,asyncRoute(async(req,res)=>{const x=parse(contactSchema,req.body);if(x.website)return res.status(201).json({ok:true});await query('INSERT INTO contact_inquiries(name,email,phone,subject,message,preferred_contact) VALUES($1,$2,$3,$4,$5,$6)',[x.name,x.email.toLowerCase(),x.phone,x.subject||'General enquiry',x.message,x.preferredContact]);res.status(201).json({ok:true})}));
app.post('/api/donors',donorLimiter,asyncRoute(async(req,res)=>{const x=parse(donorSchema,req.body);await query(`INSERT INTO donors(first_name,last_name,email,phone,country,interests,consent) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,phone=EXCLUDED.phone,country=EXCLUDED.country,interests=EXCLUDED.interests,consent=EXCLUDED.consent,updated_at=NOW()`,[x.firstName,x.lastName,x.email.toLowerCase(),x.phone,x.country,x.interests,x.consent]);res.status(201).json({ok:true})}));
app.post('/api/admin/login',loginLimiter,asyncRoute(async(req,res)=>{const body=parse(z.object({email:z.string().email().max(254),password:z.string().min(1).max(200)}),req.body);const user=await verifyPassword(body.email,body.password);if(!user)return res.status(401).json({error:'Email or password is incorrect.'});setAuthCookie(res,signToken(user));res.json({ok:true,user:{email:user.email}})}));
app.post('/api/admin/logout',(_req,res)=>{clearAuthCookie(res);res.json({ok:true})});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({email:req.admin.email}));
app.get('/api/admin/gallery',requireAdmin,asyncRoute(async(_req,res)=>{const {rows}=await query('SELECT id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt" FROM gallery_photos ORDER BY sort_order ASC, created_at DESC');res.json(rows)}));
app.post('/api/admin/uploads/sign',requireAdmin,uploadLimiter,asyncRoute(async(req,res)=>res.json(await signImageUpload(parse(z.object({fileName:z.string().max(255),contentType:z.string(),size:z.number().int()}),req.body)))));
app.post('/api/admin/gallery',requireAdmin,asyncRoute(async(req,res)=>{const x=parse(gallerySchema,req.body);const {rows}=await query('INSERT INTO gallery_photos(title,alt_text,category,image_url,storage_key) VALUES($1,$2,$3,$4,$5) RETURNING id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt"',[x.title,x.altText,x.category,x.imageUrl,x.storageKey]);res.status(201).json(rows[0])}));
app.patch('/api/admin/gallery/:id',requireAdmin,asyncRoute(async(req,res)=>{const {id}=parse(idParam,req.params),x=parse(gallerySchema,req.body);const old=await query('SELECT storage_key FROM gallery_photos WHERE id=$1',[id]);if(!old.rowCount)return res.status(404).json({error:'Photo not found.'});const {rows}=await query('UPDATE gallery_photos SET title=$2,alt_text=$3,category=$4,image_url=$5,storage_key=$6,updated_at=NOW() WHERE id=$1 RETURNING id,title,alt_text AS "altText",category,image_url AS "imageUrl",storage_key AS "storageKey",created_at AS "createdAt"',[id,x.title,x.altText,x.category,x.imageUrl,x.storageKey]);if(old.rows[0].storage_key!==x.storageKey)await deleteImage(old.rows[0].storage_key);res.json(rows[0])}));
app.delete('/api/admin/gallery/:id',requireAdmin,asyncRoute(async(req,res)=>{const {id}=parse(idParam,req.params);const {rows}=await query('DELETE FROM gallery_photos WHERE id=$1 RETURNING storage_key',[id]);if(!rows[0])return res.status(404).json({error:'Photo not found.'});await deleteImage(rows[0].storage_key);res.json({ok:true})}));
app.get('/api/admin/insights',requireAdmin,asyncRoute(async(_req,res)=>{
  const [gallery,events,inquiries,unread,donors,recentInquiries,recentDonors,countries]=await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM gallery_photos'),
    query('SELECT COUNT(*)::int AS count FROM events WHERE published=true AND starts_at>=NOW()'),
    query('SELECT COUNT(*)::int AS count FROM contact_inquiries'),
    query("SELECT COUNT(*)::int AS count FROM contact_inquiries WHERE status='new'"),
    query('SELECT COUNT(*)::int AS count FROM donors'),
    query('SELECT id,name,email,subject,status,created_at AS "createdAt" FROM contact_inquiries ORDER BY created_at DESC LIMIT 5'),
    query('SELECT id,first_name AS "firstName",last_name AS "lastName",country,created_at AS "createdAt" FROM donors ORDER BY created_at DESC LIMIT 5'),
    query('SELECT country,COUNT(*)::int AS count FROM donors GROUP BY country ORDER BY count DESC,country ASC LIMIT 5')
  ]);
  res.json({counts:{gallery:gallery.rows[0].count,upcomingEvents:events.rows[0].count,inquiries:inquiries.rows[0].count,unreadInquiries:unread.rows[0].count,donors:donors.rows[0].count},recentInquiries:recentInquiries.rows,recentDonors:recentDonors.rows,donorsByCountry:countries.rows});
}));
app.get('/api/admin/inquiries',requireAdmin,asyncRoute(async(req,res)=>{
  const status=['new','read','replied'].includes(req.query.status)?req.query.status:null;
  const {rows}=await query(`SELECT id,name,email,phone,subject,message,preferred_contact AS "preferredContact",status,created_at AS "createdAt" FROM contact_inquiries ${status?'WHERE status=$1':''} ORDER BY created_at DESC LIMIT 500`,status?[status]:[]);
  res.json(rows);
}));
app.patch('/api/admin/inquiries/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {id}=parse(idParam,req.params),{status}=parse(statusSchema,req.body);
  const {rows}=await query('UPDATE contact_inquiries SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING id,status',[id,status]);
  if(!rows[0])return res.status(404).json({error:'Message not found.'});res.json(rows[0]);
}));
app.delete('/api/admin/inquiries/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {id}=parse(idParam,req.params),{rowCount}=await query('DELETE FROM contact_inquiries WHERE id=$1',[id]);
  if(!rowCount)return res.status(404).json({error:'Message not found.'});res.json({ok:true});
}));
app.get('/api/admin/donors',requireAdmin,asyncRoute(async(_req,res)=>{
  const {rows}=await query(`SELECT d.id,d.first_name AS "firstName",d.last_name AS "lastName",d.email,d.phone,d.country,d.interests,d.created_at AS "createdAt",(SELECT MAX(prepared_at) FROM donor_reminders r WHERE r.donor_id=d.id) AS "lastReminderAt" FROM donors d ORDER BY d.created_at DESC LIMIT 1000`);
  res.json(rows);
}));
app.post('/api/admin/donors/:id/reminders',requireAdmin,asyncRoute(async(req,res)=>{
  const {id}=parse(idParam,req.params),x=parse(reminderSchema,req.body);
  const donor=await query('SELECT id FROM donors WHERE id=$1',[id]);
  if(!donor.rowCount)return res.status(404).json({error:'Donor not found.'});
  const {rows}=await query('INSERT INTO donor_reminders(donor_id,channel,message) VALUES($1,$2,$3) RETURNING id,channel,message,prepared_at AS "preparedAt"',[id,x.channel,x.message]);
  res.status(201).json(rows[0]);
}));
app.delete('/api/admin/donors/:id',requireAdmin,asyncRoute(async(req,res)=>{
  const {id}=parse(idParam,req.params),{rowCount}=await query('DELETE FROM donors WHERE id=$1',[id]);
  if(!rowCount)return res.status(404).json({error:'Donor not found.'});res.json({ok:true});
}));
app.get('/api/admin/events',requireAdmin,asyncRoute(async(_req,res)=>{const {rows}=await query('SELECT id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",published,created_at AS "createdAt" FROM events ORDER BY starts_at DESC');res.json(rows)}));
app.post('/api/admin/events',requireAdmin,asyncRoute(async(req,res)=>{const x=parse(eventSchema,req.body);const {rows}=await query('INSERT INTO events(title,description,starts_at,location,category,registration_url,image_url,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",published,created_at AS "createdAt"',[x.title,x.description,x.startsAt,x.location,x.category,x.registrationUrl,x.imageUrl,x.published]);res.status(201).json(rows[0])}));
app.patch('/api/admin/events/:id',requireAdmin,asyncRoute(async(req,res)=>{const {id}=parse(idParam,req.params),x=parse(eventSchema,req.body);const {rows}=await query('UPDATE events SET title=$2,description=$3,starts_at=$4,location=$5,category=$6,registration_url=$7,image_url=$8,published=$9,updated_at=NOW() WHERE id=$1 RETURNING id,title,description,starts_at AS "startsAt",location,category,registration_url AS "registrationUrl",image_url AS "imageUrl",published,created_at AS "createdAt"',[id,x.title,x.description,x.startsAt,x.location,x.category,x.registrationUrl,x.imageUrl,x.published]);if(!rows[0])return res.status(404).json({error:'Event not found.'});res.json(rows[0])}));
app.delete('/api/admin/events/:id',requireAdmin,asyncRoute(async(req,res)=>{const {id}=parse(idParam,req.params);const {rowCount}=await query('DELETE FROM events WHERE id=$1',[id]);if(!rowCount)return res.status(404).json({error:'Event not found.'});res.json({ok:true})}));
app.use((err,_req,res,_next)=>{console.error(err);const status=err.status||500;res.status(status).json({error:status<500?err.message:'The server could not complete that request.'})});
app.listen(port,()=>console.log(`Happiness API listening on ${port}`));
