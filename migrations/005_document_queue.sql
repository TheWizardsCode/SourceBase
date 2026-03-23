-- Create document queue table for persisting URLs across bot restarts
CREATE TABLE IF NOT EXISTS document_queue (
  id SERIAL PRIMARY KEY,
  url VARCHAR(2048) NOT NULL,
  discord_message_id VARCHAR(32) NOT NULL,
  discord_channel_id VARCHAR(32) NOT NULL,
  discord_author_id VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_document_queue_status ON document_queue(status);
CREATE INDEX IF NOT EXISTS idx_document_queue_created_at ON document_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_document_queue_url ON document_queue(url);

-- Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_document_queue_updated_at ON document_queue;
CREATE TRIGGER update_document_queue_updated_at
  BEFORE UPDATE ON document_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add comment explaining the table
COMMENT ON TABLE document_queue IS 'Queue for URLs waiting to be processed by the document ingestion service';
