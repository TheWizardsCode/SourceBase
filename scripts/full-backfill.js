#!/usr/bin/env node
/**
 * scripts/full-backfill.js
 *
 * Triggers a full backfill of all embeddings using the current embedder.
 *
 * Usage:
 *   node scripts/full-backfill.js
 *
 * Environment variables (or .env):
 *   DATABASE_URL        - PostgreSQL connection string
 *   LLM_BASE_URL       - LLM/proxy base URL (for embedder)
 *   LLM_EMBEDDING_MODEL - Model name for embeddings (default: from LLM_MODEL)
 *   LLM_EMBEDDING_DIM  - Target embedding dimension (default: 1024)
 *   LLM_MAX_RETRIES    - Max retries on embed failure (default: 2)
 *   LLM_RETRY_DELAY_MS - Retry delay in ms (default: 250)
 *   BATCH_SIZE         - Links to fetch per DB batch (default: 50)
 *   MAX_EMBED_CHARS    - Max characters per embed chunk (default: 2500; lower if proxy
 *                        rejects with "input too large" — HTML/special chars are token-dense)
 *
 * What it does:
 *   1. Fetches all links from the DB (up to MAX_LINKS total).
 *   2. Chunks large text and embeds each chunk, averaging the resulting vectors.
 *   3. Updates each link's embedding in the DB.
 *   4. Reports progress every BATCH_SIZE links.
 *
 * NOTE: This does NOT update Qdrant — run scripts/migrate-qdrant.js first to
 * recreate the Qdrant collection at the new dimension. New ingestions will
 * re-populate Qdrant automatically.
 */

import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://localhost:11434/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.LLM_EMBEDDING_MODEL || LLM_MODEL;
const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES || '2', 10);
const RETRY_DELAY_MS = parseInt(process.env.LLM_RETRY_DELAY_MS || '250', 10);
const VECTOR_DIM = parseInt(process.env.LLM_EMBEDDING_DIM || '1024', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);
const MAX_EMBED_CHARS = parseInt(process.env.MAX_EMBED_CHARS || '2500', 10);
const MAX_LINKS = parseInt(process.env.MAX_LINKS || '10000', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';

console.log('Full backfill starting');
console.log(`  Database: ${DATABASE_URL.replace(/\/\/.*:.*@/, '//***@')}`);
console.log(`  Embedder: ${LLM_BASE_URL} model=${EMBEDDING_MODEL}`);
console.log(`  Target dim: ${VECTOR_DIM}`);
console.log(`  Max chars per embed chunk: ${MAX_EMBED_CHARS} (lower with MAX_EMBED_CHARS env var if proxy rejects)`);
console.log(`  DB batch size: ${BATCH_SIZE}`);
console.log(`  Max links: ${MAX_LINKS}`);
console.log(`  Dry run: ${DRY_RUN}`);
console.log('');

const pool = new Pool({ connectionString: DATABASE_URL });

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedWithRetry(text) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${LLM_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      });
      if (!response.ok) {
        const errBody = await response.text();
        if (response.status === 500 && errBody.includes('too large')) {
          throw new Error(`Token limit exceeded (${text.length} chars — lower MAX_EMBED_CHARS)`);
        }
        throw new Error(`Embedding request failed (${response.status}): ${errBody}`);
      }
      const json = await response.json();
      const embedding = json.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Embedding response missing vector');
      }
      return embedding;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * Math.max(1, attempt + 1));
      }
    }
  }
  throw lastError;
}

function chunkText(text, maxChars) {
  if (!text || text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf(' ', maxChars);
    if (splitIdx === -1) splitIdx = maxChars;
    const part = remaining.slice(0, splitIdx).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitIdx).trim();
  }
  return chunks;
}

function averageVectors(vectors) {
  if (!vectors.length) return null;
  const len = vectors[0].length;
  const sum = new Array(len).fill(0);
  for (const vec of vectors) {
    if (vec.length !== len) return null;
    for (let i = 0; i < len; i++) sum[i] += vec[i];
  }
  return sum.map(v => v / vectors.length);
}

function buildEmbeddingText(link) {
  return [link.title, link.transcript, link.summary, link.content]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function fetchLinks(offset) {
  const result = await pool.query(
    `
    SELECT id, url, title, transcript, summary, content
      FROM links
     WHERE (title IS NOT NULL OR transcript IS NOT NULL OR summary IS NOT NULL OR content IS NOT NULL)
     ORDER BY id
     LIMIT $1 OFFSET $2
    `,
    [BATCH_SIZE, offset]
  );
  return result.rows;
}

async function upsertEmbedding(id, embedding) {
  const vectorLiteral = `[${embedding.join(',')}]`;
  await pool.query(
    `UPDATE links SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
    [vectorLiteral, id]
  );
}

async function processLink(link) {
  const text = buildEmbeddingText(link);
  if (!text) {
    return false;
  }

  const textLen = text.length;
  const chunks = chunkText(text, MAX_EMBED_CHARS);
  const vectors = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const vec = await embedWithRetry(chunk);
      vectors.push(vec);
    } catch (err) {
      throw new Error(`chunk ${i + 1}/${chunks.length} (${chunk.length} chars) failed: ${err.message}`);
    }
  }

  if (!vectors.length) {
    throw new Error('No vectors returned');
  }

  const averaged = averageVectors(vectors);
  if (!averaged) {
    throw new Error('Vector dimension mismatch during averaging');
  }

  let embedding = averaged;

  if (embedding.length !== VECTOR_DIM) {
    if (embedding.length > VECTOR_DIM) {
      embedding = embedding.slice(0, VECTOR_DIM);
    } else {
      const padding = new Array(VECTOR_DIM - embedding.length).fill(0);
      embedding = embedding.concat(padding);
    }
  }

  if (!DRY_RUN) {
    await upsertEmbedding(link.id, embedding);
  }
  console.log(`    ${textLen} chars → ${chunks.length} chunk(s) → ${embedding.length}D vector`);
  return true;
}

async function main() {
  const startTime = Date.now();
  let offset = 0;
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  while (offset < MAX_LINKS) {
    const links = await fetchLinks(offset);
    if (links.length === 0) break;

    console.log(`\nBatch ${Math.floor(offset / BATCH_SIZE) + 1}: processing ${links.length} links (offset=${offset})…`);

    for (const link of links) {
      const urlShort = link.url.length > 60 ? link.url.slice(0, 57) + '...' : link.url;
      try {
        const ok = await processLink(link);
        if (ok) {
          processed++;
          console.log(`  [${link.id}] ${urlShort} → embedded`);
        } else {
          skipped++;
          console.log(`  [${link.id}] ${urlShort} → skipped (no text)`);
        }
      } catch (err) {
        failed++;
        console.error(`  [${link.id}] ${urlShort} → FAILED: ${err.message}`);
      }
    }

    offset += BATCH_SIZE;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  Progress: ${processed} processed, ${failed} failed, ${skipped} skipped (${elapsed}s elapsed)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nBackfill complete.`);
  console.log(`  Total processed: ${processed}`);
  console.log(`  Total failed:    ${failed}`);
  console.log(`  Total skipped:   ${skipped}`);
  console.log(`  Time elapsed:   ${elapsed}s`);

  await pool.end();

  if (failed > 0) {
    console.warn('\nSome links failed. Re-running this script will retry them.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
