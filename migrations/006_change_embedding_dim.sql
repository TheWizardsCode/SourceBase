-- Migration: change embedding column from vector(1536/2000) to vector(1024)
-- to match the native output dimension of the dedicated embedding model
-- (e.g. mxbai-embed-large-v1).
--
-- BEFORE RUNNING: ensure no new embeddings are being written (stop the bot
-- or set STARTUP_RECOVERY_MAX_MESSAGES=0 to prevent ingestion during migration).
--
-- NOTE: This migration NULLs out all existing embeddings. Run scripts/full-backfill.js
-- after this to regenerate all embeddings at the new dimension.
--
-- STEP 1: Drop the existing vector index (required before altering column type)
DROP INDEX IF EXISTS links_embedding_idx;

-- STEP 2: NULL out existing embeddings (they will be regenerated at 1024-dim by full-backfill)
UPDATE links SET embedding = NULL;

-- STEP 3: Change the embedding column dimension
ALTER TABLE links ALTER COLUMN embedding TYPE vector(1024);

-- STEP 4: Bump maintenance_work_mem so the index build doesn't fail.
SET maintenance_work_mem = '256MB';

-- STEP 5: Recreate the IVF index for the new dimension.
CREATE INDEX IF NOT EXISTS links_embedding_idx ON links USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- STEP 6: Reset maintenance_work_mem
RESET maintenance_work_mem;

-- STEP 7: Verify
-- SELECT attname, atttypid::regtype AS type
--   FROM pg_attribute
--   WHERE attrelid = 'links'::regclass AND attname = 'embedding';
