import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const bucket = process.env.R2_BUCKET_NAME;
const extensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const maxImageSize = 10 * 1024 * 1024;

let s3;
function client() {
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    throw Object.assign(new Error('Image storage is not configured.'), { status: 503, safeMessage: `Image storage is missing Render setting(s): ${missing.join(', ')}.` });
  }
  if (!s3) {
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3;
}

function publicBaseUrl() {
  const value = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (!value) {
    throw Object.assign(new Error('Image delivery URL is not configured.'), { status: 503, safeMessage: 'Set R2_PUBLIC_BASE_URL to the public URL Cloudflare shows for this bucket.' });
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('HTTPS is required.');
  } catch {
    throw Object.assign(new Error('Image delivery URL is invalid.'), { status: 503, safeMessage: 'R2_PUBLIC_BASE_URL must be a valid HTTPS URL with no trailing slash.' });
  }
  return value;
}

function safeFileName(value, extension) {
  const name = String(value || 'photo')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-70);
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `photo.${extension}`;
}

export async function saveImage({ buffer, fileName, contentType }) {
  const extension = extensions.get(contentType);
  if (!extension) {
    throw Object.assign(new Error('Choose a JPEG, PNG or WebP image.'), { status: 400 });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > maxImageSize) {
    throw Object.assign(new Error('Images must be between 1 byte and 10 MB.'), { status: 400 });
  }

  const baseUrl = publicBaseUrl();
  const storageKey = `gallery/${randomUUID()}-${safeFileName(fileName, extension)}`;
  try {
    await client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
      ContentLength: buffer.length,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } catch (error) {
    if (error.status) throw error;
    console.error('R2 upload failed:', error);
    throw Object.assign(new Error('Cloudflare R2 rejected the upload.'), { status: 502, safeMessage: 'Cloudflare R2 rejected the upload. Check the Render R2 credentials, account ID and bucket name.' });
  }

  return { storageKey, imageUrl: `${baseUrl}/${storageKey}` };
}

export async function deleteImage(storageKey) {
  if (!storageKey) return;
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
}
