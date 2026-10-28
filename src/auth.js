import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
const cookieName='happiness_admin';
const cookieOptions={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:8*60*60*1000};
export function signToken(user){return jwt.sign({sub:user.id,email:user.email},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'happiness-home-api',audience:'happiness-home-admin'});}
export function setAuthCookie(res,token){res.cookie(cookieName,token,cookieOptions);}
export function clearAuthCookie(res){const {maxAge,...clearOptions}=cookieOptions;res.clearCookie(cookieName,clearOptions);}
export async function requireAdmin(req,res,next){res.set('Cache-Control','no-store');res.set('X-Robots-Tag','noindex, nofollow');try{const token=req.cookies[cookieName];if(!token)return res.status(401).json({error:'Please sign in.'});const data=jwt.verify(token,process.env.JWT_SECRET,{issuer:'happiness-home-api',audience:'happiness-home-admin'});const {rows}=await query('SELECT id,email FROM admins WHERE id=$1',[data.sub]);if(!rows[0])return res.status(401).json({error:'Please sign in.'});req.admin=rows[0];next();}catch{return res.status(401).json({error:'Your session has expired. Please sign in again.'});}}
export async function createAdmin(email,password){const hash=await bcrypt.hash(password,12);return query('INSERT INTO admins (email,password_hash) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash',[email.toLowerCase(),hash]);}
export async function verifyPassword(email,password){const {rows}=await query('SELECT id,email,password_hash FROM admins WHERE email=$1',[email.toLowerCase()]);if(!rows[0]||!(await bcrypt.compare(password,rows[0].password_hash)))return null;return {id:rows[0].id,email:rows[0].email};}
