#!/usr/bin/env node
/**
 * scripts/enqueue-urls.js
 *
 * Fast-enqueues URLs from a CSV into the document_queue table.
 * Does NOT process them — the bot picks them up asynchronously.
 *
 * Usage:
 *   node scripts/enqueue-urls.js --csv <path>
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    csv: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help || !args.csv) {
  console.log('Usage: node scripts/enqueue-urls.js --csv <path>');
  process.exit(0);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function insertBatch(urls) {
  if (!urls.length) return;
  const values = urls.map((url, i) => {
    const base = i * 7;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  }).join(',');
  const params = urls.flatMap(u => [
    u,
    `reimport-${Date.now()}`,
    'cli',
    'cli-user',
    'pending',
    0,
    null,
  ]);
  await pool.query(
    `INSERT INTO document_queue (url, discord_message_id, discord_channel_id, discord_author_id, status, attempts, error_message)
     VALUES ${values}`,
    params
  );
}

async function readCsvUrls(path) {
  const urls = [];
  await pipeline(
    createReadStream(path),
    parse({ columns: true, skip_empty_lines: true, trim: true }),
    async function* (records) {
      for await (const record of records) {
        const url = record.url || record.URL || Object.values(record)[0];
        if (url) urls.push(url.trim());
      }
    }
  );
  return urls;
}

const BATCH = 100;
async function main() {
  const urls = await readCsvUrls(args.csv);
  console.log(`Found ${urls.length} URLs, inserting...`);
  let inserted = 0;
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    await insertBatch(batch);
    inserted += batch.length;
    process.stdout.write(`\r  ${inserted}/${urls.length}`);
  }
  console.log('\nDone.');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
