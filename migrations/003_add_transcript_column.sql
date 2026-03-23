-- Add transcript column to links table for YouTube captions
ALTER TABLE links ADD COLUMN IF NOT EXISTS transcript TEXT;

-- Add index for transcript searches (if needed in the future)
-- CREATE INDEX IF NOT EXISTS idx_links_transcript ON links USING gin(to_tsvector('english', transcript));

-- Update metadata to include transcript info for YouTube videos
-- This is handled in application code, but we can add a comment
COMMENT ON COLUMN links.transcript IS 'YouTube video transcript/captions when available';
