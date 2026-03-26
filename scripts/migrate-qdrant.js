#!/usr/bin/env node
/**
 * scripts/migrate-qdrant.js
 *
 * Migrates the Qdrant collection to a new vector dimension.
 *
 * Usage:
 *   node scripts/migrate-qdrant.js
 *
 * Environment variables (or .env):
 *   QDRANT_URL         - Qdrant server URL (default: http://127.0.0.1:6333)
 *   QDRANT_COLLECTION - Collection name (default: links_vectors)
 *   VECTOR_DIM         - New vector dimension (default: 1024)
 *
 * What it does:
 *   1. Deletes the existing Qdrant collection (all vectors are lost).
 *   2. Recreates the collection with the new vector dimension and
 *      cosine distance metric.
 *   3. Exits with code 0 on success, non-zero on failure.
 *
 * After running this migration, all new ingestions will re-index vectors
 * at the new dimension. Existing vectors will need to be re-ingested or
 * backfilled to appear in Qdrant searches again.
 */

import 'dotenv/config';

const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const COLLECTION = process.env.QDRANT_COLLECTION || 'links_vectors';
const VECTOR_DIM = parseInt(process.env.VECTOR_DIM || '1024', 10);

async function request(method, path, body) {
  const url = `${QDRANT_URL}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function collectionExists() {
  try {
    await request('GET', `/collections/${COLLECTION}`);
    return true;
  } catch {
    return false;
  }
}

async function deleteCollection() {
  console.log(`Deleting collection '${COLLECTION}'...`);
  await request('DELETE', `/collections/${COLLECTION}`);
  console.log('Collection deleted.');
}

async function createCollection() {
  console.log(`Creating collection '${COLLECTION}' with vector_size=${VECTOR_DIM}, distance=Cosine...`);
  await request('PUT', `/collections/${COLLECTION}`, {
    vectors: {
      size: VECTOR_DIM,
      distance: 'Cosine',
    },
  });
  console.log('Collection created.');
}

async function main() {
  console.log(`Qdrant migration: ${COLLECTION} @ ${QDRANT_URL}`);
  console.log(`Target vector dimension: ${VECTOR_DIM}`);
  console.log('');

  const exists = await collectionExists();
  if (!exists) {
    console.log('Collection does not exist — nothing to migrate. Creating fresh collection.');
    await createCollection();
    console.log('\nMigration complete (fresh collection created).');
    process.exit(0);
  }

  console.log(`Collection '${COLLECTION}' exists. Proceeding with deletion…`);
  console.log('WARNING: all vectors in the collection will be permanently deleted.');
  console.log('');

  await deleteCollection();
  await createCollection();

  console.log('\nMigration complete. Qdrant collection is ready for new (1024-dim) vectors.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
