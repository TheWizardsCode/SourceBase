#!/usr/bin/env node
/**
 * scripts/reimport-urls.js
 *
 * Wipes existing data and re-imports all URLs from a CSV backup.
 *
 * Usage:
 *   node scripts/reimport-urls.js --csv <path> [--batch-size <n>] [--concurrency <n>]
 *
 * Environment variables (or .env):
 *   DATABASE_URL       - PostgreSQL connection string
 *   QDRANT_URL        - Qdrant server URL (default: http://127.0.0.1:6333)
 *   QDRANT_COLLECTION - Qdrant collection name (default: links_vectors)
 *   VECTOR_DIM        - Vector dimension (default: 1024)
 *   BATCH_SIZE       - URLs per batch (default: 10)
 *   CONCURRENCY      - Parallel workers (default: 3)
 *   DRY_RUN          - If "true", only print what would happen
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createReadStream, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL  = process.env.DATABASE_URL;
const QDRANT_URL    = process.env.QDRANT_URL    || 'http://127.0.0.1:6333';
const COLLECTION    = process.env.QDRANT_COLLECTION || 'links_vectors';
const VECTOR_DIM    = parseInt(process.env.VECTOR_DIM || '1024', 10);
const DRY_RUN       = process.env.DRY_RUN === 'true';
const SB_BIN        = './dist/src/cli/index.js';

const { values: args } = parseArgs({
  options: {
    'csv':          { type: 'string' },
    'batch-size':   { type: 'string', default: '10' },
    'concurrency':  { type: 'string', default: '3' },
    'dry-run':      { type: 'boolean', default: false },
    'help':         { type: 'boolean', default: false },
  },
});

function autoDetectCsv() {
  const files = readdirSync('backups')
    .filter(f => f.startsWith('links-urls-') && f.endsWith('.csv'))
    .sort()
    .reverse();
  if (!files.length) return null;
  return `backups/${files[0]}`;
}

const CSV_PATH    = args.csv ?? autoDetectCsv();
const BATCH_SIZE  = parseInt(args['batch-size'] || '10', 10);
const CONCURRENCY = parseInt(args['concurrency'] || '3', 10);
const DRY         = args['dry-run'] || DRY_RUN;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

if (args.help) {
  console.log(`Usage: node scripts/reimport-urls.js [options]
Options:
  --csv <path>           Path to URLs CSV (default: auto-detect latest in backups/)
  --batch-size <n>       URLs per batch (default: 10)
  --concurrency <n>      Parallel workers (default: 3)
  --dry-run              Print actions without executing
  --help                 Show this help`);
  process.exit(0);
}

if (!CSV_PATH) {
  console.error('No CSV specified and none found in backups/. Run with --csv <path>.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function qdrant(method, path, body) {
  const url = `${QDRANT_URL}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!res.ok) throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

async function collectionExists() {
  try { await qdrant('GET', `/collections/${COLLECTION}`); return true; }
  catch { return false; }
}

async function deleteCollection() {
  console.log(`  Deleting Qdrant collection '${COLLECTION}'...`);
  await qdrant('DELETE', `/collections/${COLLECTION}`);
}

async function createCollection() {
  console.log(`  Creating Qdrant collection '${COLLECTION}' (dim=${VECTOR_DIM}, Cosine)...`);
  await qdrant('PUT', `/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_DIM, distance: 'Cosine' },
  });
}

async function truncateTables(pool) {
  console.log('  Truncating PostgreSQL tables...');
  await pool.query('BEGIN');
  await pool.query('TRUNCATE TABLE embedding_backfill_queue, links CASCADE');
  await pool.query('COMMIT');
  console.log('  Tables truncated.');
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

let enqueueOk = 0;
let enqueueErrors = 0;

async function enqueueUrl(url) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const proc = spawn('node', [SB_BIN, 'add', url], {
      env: { ...process.env, DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) enqueueOk++;
      else {
        enqueueErrors++;
        if (enqueueErrors <= 5) console.error(`\n    ERROR ${url}: ${stderr.trim().split('\n').pop()}`);
      }
      resolve();
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('========================================');
  console.log('  SourceBase Reimport Script');
  console.log('========================================');
  console.log(`  CSV:          ${CSV_PATH}`);
  console.log(`  Batch size:   ${BATCH_SIZE}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Dry run:      ${DRY}`);
  console.log('');

  // 1. Read URLs from CSV
  console.log('[1/5] Reading URLs from CSV...');
  let urls;
  try {
    urls = await readCsvUrls(CSV_PATH);
  } catch (err) {
    console.error(`  Failed to read CSV: ${err.message}`);
    process.exit(1);
  }
  console.log(`  Found ${urls.length} URLs.`);
  if (urls.length === 0) { console.error('  No URLs found.'); process.exit(1); }
  if (DRY) { console.log('  DRY RUN — stopping here.'); process.exit(0); }

  // 2. Truncate PostgreSQL
  console.log('[2/5] Clearing PostgreSQL...');
  const pool = new Pool({ connectionString: DATABASE_URL });
  try { await truncateTables(pool); }
  catch (err) { console.error(`  Truncate failed: ${err.message}`); await pool.end(); process.exit(1); }

  // 3. Reset Qdrant
  console.log('[3/5] Clearing Qdrant...');
  try {
    if (await collectionExists()) await deleteCollection();
    await createCollection();
  } catch (err) { console.error(`  Qdrant reset failed: ${err.message}`); await pool.end(); process.exit(1); }

  // 4. Enqueue URLs
  console.log(`[4/5] Enqueuing ${urls.length} URLs (${CONCURRENCY} parallel, batch=${BATCH_SIZE})...`);
  enqueueOk = 0;
  enqueueErrors = 0;

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const workers = [];
    for (let w = 0; w < CONCURRENCY && w < batch.length; w++) {
      workers.push(enqueueUrl(batch[w]));
    }
    await Promise.all(workers);
    await sleep(200);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const idx = Math.min(i + BATCH_SIZE, urls.length);
    process.stdout.write(`\r  Progress: ${idx}/${urls.length} (${((idx / urls.length) * 100).toFixed(1)}%) — ${enqueueOk} ok, ${enqueueErrors} errors — ${elapsed}s   `);
  }

  console.log('');
  console.log('');

  // 5. Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[5/5] Summary');
  console.log(`  Total URLs:     ${urls.length}`);
  console.log(`  Enqueued ok:    ${enqueueOk}`);
  console.log(`  Errors:         ${enqueueErrors}`);
  console.log(`  Time elapsed:   ${elapsed}s`);
  console.log('');

  if (enqueueErrors > 0) console.warn('  Some URLs failed. Re-running this script will retry them.');
  else console.log('  All URLs enqueued successfully.');

  await pool.end();
  process.exit(enqueueErrors > 0 ? 1 : 0);
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
