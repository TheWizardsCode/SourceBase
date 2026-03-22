import { Pool } from "pg";

import { config } from "../config.js";

let pool: Pool | undefined;

export function getDbPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.DATABASE_URL });
  }

  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = undefined;
}
