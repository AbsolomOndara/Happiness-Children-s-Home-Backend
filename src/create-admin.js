import 'dotenv/config';
import { createAdmin } from './auth.js';
import { pool } from './db.js';
try {
  const email=process.env.ADMIN_EMAIL?.trim();
  const password=process.env.ADMIN_PASSWORD;
  if(!email||!password||password.length<12)throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in the private environment before creating the admin.');
  await createAdmin(email,password);
  console.log(`Admin account ready for ${email.toLowerCase()}.`);
} finally { await pool.end(); }
