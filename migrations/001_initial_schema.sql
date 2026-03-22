CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS links (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  title TEXT,
  summary TEXT,
  content TEXT,
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_checkpoints (
  channel_id TEXT PRIMARY KEY,
  last_processed_message_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS links_last_seen_at_idx ON links (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS links_embedding_idx ON links USING ivfflat (embedding vector_cosine_ops);
