-- Initial Schema for SourceBase
-- This is a consolidated schema that includes all tables and columns.
-- Run this on a fresh database instead of sequential migrations.

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Core Tables
-- ============================================================================

-- Links table: stores indexed content with embeddings
CREATE TABLE IF NOT EXISTS links (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  title TEXT,
  summary TEXT,
  content TEXT,
  transcript TEXT,                          -- YouTube captions/transcripts
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1024),                   -- Matches embedding model output dimension
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- App checkpoints: tracks last processed message per channel
CREATE TABLE IF NOT EXISTS app_checkpoints (
  channel_id TEXT PRIMARY KEY,
  last_processed_message_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Queue Tables
-- ============================================================================

-- Document queue: URLs waiting to be processed
-- Uses neutral column names to support both Discord bot and CLI contexts
CREATE TABLE IF NOT EXISTS document_queue (
  id SERIAL PRIMARY KEY,
  url VARCHAR(2048) NOT NULL,
  source_id VARCHAR(64) NOT NULL,           -- Discord message ID or CLI-generated ID
  source_context VARCHAR(64) NOT NULL,      -- Discord channel ID or "cli" for CLI usage
  author_id VARCHAR(64) NOT NULL,           -- Discord user ID or "cli-user" for CLI usage
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- Backfill queue: tracks items needing backfill processing
CREATE TABLE IF NOT EXISTS backfill_queue (
  id SERIAL PRIMARY KEY,
  url VARCHAR(2048) NOT NULL,
  video_id VARCHAR(20),
  content_type VARCHAR(50) NOT NULL,        -- 'embedding', 'transcript', 'summary'
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  priority INTEGER NOT NULL DEFAULT 100,    -- Lower is higher priority
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE       -- SLA deadline (24h from creation)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Links indexes
CREATE INDEX IF NOT EXISTS links_last_seen_at_idx ON links (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS links_embedding_idx ON links USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Document queue indexes
CREATE INDEX IF NOT EXISTS idx_document_queue_status ON document_queue(status);
CREATE INDEX IF NOT EXISTS idx_document_queue_created_at ON document_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_document_queue_url ON document_queue(url);

-- Backfill queue indexes
CREATE INDEX IF NOT EXISTS idx_backfill_queue_status ON backfill_queue(status);
CREATE INDEX IF NOT EXISTS idx_backfill_queue_priority ON backfill_queue(priority);
CREATE INDEX IF NOT EXISTS idx_backfill_queue_expires ON backfill_queue(expires_at) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_backfill_queue_url ON backfill_queue(url);

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================================================
-- Triggers
-- ============================================================================

-- Document queue updated_at trigger
DROP TRIGGER IF EXISTS update_document_queue_updated_at ON document_queue;
CREATE TRIGGER update_document_queue_updated_at
  BEFORE UPDATE ON document_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Backfill queue updated_at trigger
DROP TRIGGER IF EXISTS update_backfill_queue_updated_at ON backfill_queue;
CREATE TRIGGER update_backfill_queue_updated_at
  BEFORE UPDATE ON backfill_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE links IS 'Stores indexed links with metadata, summaries, and embeddings';
COMMENT ON COLUMN links.transcript IS 'YouTube video transcript/captions when available';
COMMENT ON TABLE app_checkpoints IS 'Tracks last processed message ID per Discord channel';
COMMENT ON TABLE document_queue IS 'Queue for URLs waiting to be processed. Supports both Discord bot and CLI contexts with neutral column names.';
COMMENT ON TABLE backfill_queue IS 'Queue for tracking items that need backfill processing (embeddings, transcripts, summaries)';
