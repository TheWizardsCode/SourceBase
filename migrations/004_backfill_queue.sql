-- Create backfill queue table for tracking failed/missing embeddings and transcripts
CREATE TABLE IF NOT EXISTS backfill_queue (
  id SERIAL PRIMARY KEY,
  url VARCHAR(2048) NOT NULL,
  video_id VARCHAR(20),
  content_type VARCHAR(50) NOT NULL, -- 'embedding', 'transcript', 'summary'
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  priority INTEGER NOT NULL DEFAULT 100, -- Lower is higher priority
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE -- SLA deadline (24h from creation)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_backfill_queue_status ON backfill_queue(status);
CREATE INDEX IF NOT EXISTS idx_backfill_queue_priority ON backfill_queue(priority);
CREATE INDEX IF NOT EXISTS idx_backfill_queue_expires ON backfill_queue(expires_at) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_backfill_queue_url ON backfill_queue(url);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_backfill_queue_updated_at ON backfill_queue;
CREATE TRIGGER update_backfill_queue_updated_at
  BEFORE UPDATE ON backfill_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add comment explaining the table
COMMENT ON TABLE backfill_queue IS 'Queue for tracking items that need backfill processing (embeddings, transcripts, summaries)';
