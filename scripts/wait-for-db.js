#!/usr/bin/env node
import { Pool } from 'pg';

const url = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/sourcebase';
const maxAttempts = Number(process.env.WAIT_DB_ATTEMPTS || 60);
const delayMs = Number(process.env.WAIT_DB_DELAY_MS || 1000);

async function wait() {
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 1000 });
    try {
      const client = await pool.connect();
      client.release();
      await pool.end();
      console.log(`DB ready after ${attempts} attempt(s)`);
      return 0;
    } catch (err) {
      await pool.end().catch(() => {});
      if (attempts % 5 === 0) {
        console.error(`DB not ready yet (attempt ${attempts}): ${err?.message || err}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error(`Timed out waiting for DB after ${maxAttempts} attempts`);
  return 1;
}

wait().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });