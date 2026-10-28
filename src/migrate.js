import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db.js';
try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
  for(const name of files){
    const found=await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name]);
    if(found.rowCount)continue;
    const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
    const client=await pool.connect();
    try{await client.query('BEGIN');await client.query(sql);await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);await client.query('COMMIT');console.log(`Applied ${name}`)}
    catch(e){await client.query('ROLLBACK');throw e}
    finally{client.release()}
  }
  console.log('Database migrations complete.');
} finally {await pool.end()}
