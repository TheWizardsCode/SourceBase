# Discord Link Aggregation Bot

A TypeScript Discord bot that monitors channels, indexes shared links, and provides semantic search capabilities. Perfect for communities that want to build a searchable knowledge base from shared resources.

## Overview

SourceBase automatically extracts URLs from Discord messages, fetches content metadata, generates AI-powered summaries and embeddings, and stores everything in a searchable database. When you or your community members share links, the bot makes them discoverable through natural language search.

**Key Use Cases:**
- Build a searchable archive of resources shared in your Discord community
- Quickly find previously shared articles, videos, and documentation
- Create a knowledge base that grows organically as your community shares content

## Features

- 🔗 **Link Ingestion**: Extracts and stores URLs from Discord messages
- 📺 **YouTube Support**: Full support for YouTube videos with metadata, captions, and transcripts
- 🧠 **AI-Powered**: Generates summaries and embeddings using LLM (Ollama/OpenAI compatible)
- 🔍 **Semantic Search**: Search links by meaning, not just keywords
- 📊 **Backfill Queue**: Automatic retry for failed operations with SLA tracking
- 🎭 **Discord Reactions**: Success/failure feedback on message processing

### Discord Inline Ingestion (ob add)

- The bot supports ingesting raw text directly from Discord using the `ob add` trigger.
- Two supported patterns:
  - Inline: `ob add <text>` — paste the text you want the bot to ingest on the same message.
  - Reply: Post the text in one message, then reply to that message with `ob add` to instruct the bot to ingest the referenced message's content.

- Behavior and limits:
  - The bot writes the provided text to a temporary file and calls the OpenBrain CLI (`ob add`) with a `file://` URL so the existing CLI-based ingestion pipeline is reused.
  - To avoid abuse, the bot enforces a conservative default size limit of 64 KiB for direct text ingestion. You can override this limit with the environment variable `OB_ADD_MAX_BYTES` (value in bytes).
  - Attachment support:
    - You can reply to a message that contains a text-like file attachment (for example `.md`, `.markdown`, `.txt`) with `ob add` and the bot will fetch the attachment body and ingest it.
    - The bot accepts files with a text/* Content-Type or filenames ending in `.md`, `.markdown`, or `.txt`. Binary files (e.g. `application/octet-stream`) are rejected with a helpful error.
    - The same size limit (default 64 KiB, configurable via `OB_ADD_MAX_BYTES`) applies to attachments; oversized attachments are rejected with a clear message.
  - If the bot cannot fetch the referenced message (reply flow), it will reply with a helpful message explaining the permission issue and how to proceed.
  - If the CLI is unavailable, the bot will notify the user with a friendly error message.

Example:

```text
Paste long text into a message and then reply to it with:
  ob add

Or post the text inline:
  ob add The quick brown fox jumps over the lazy dog.
```

## Quick Start

Want to get running quickly? Here's the minimal setup:

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill environment variables
cp .env.example .env
# Edit .env and add: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DATABASE_URL, LLM_BASE_URL, LLM_MODEL

# 3. Set up database
npm run db:migrate

# 4. Run the bot
npm run start:dev
```

See [Local Setup](#local-setup) below for detailed instructions.

## Requirements

- Node.js 20+
- npm 10+
- PostgreSQL 14+ with pgvector extension
- (Optional) Ollama or OpenAI-compatible API for LLM features

## Local Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Copy environment template:**

   ```bash
   cp .env.example .env
   ```

3. **Fill in required values in `.env`:**

   Required:
   - `DISCORD_BOT_TOKEN` - From Discord Developer Portal
   - `DISCORD_CHANNEL_ID` - Channel to monitor
   - `DATABASE_URL` - PostgreSQL connection string
   - `LLM_BASE_URL` - e.g., `http://localhost:11434/v1` for Ollama
   - `LLM_MODEL` - e.g., `llama3.2` or `gpt-4o-mini`

   Optional (for YouTube support):
   - `YOUTUBE_API_KEY` - From Google Cloud Console
   - `YOUTUBE_CAPTION_LANGUAGE` - Preferred caption language (default: `en`)
   - `ENABLE_YOUTUBE_CAPTIONS` - Enable/disable captions (default: `true`)

   Optional (for summary posting in Discord threads):
   - `SEND_SUMMARY_ON_INSERT` - Post generated summary after successful `ob add` (default: `true`)
   - `DEFAULT_DISCORD_CHANNEL_ID` - Fallback channel if thread posting is not available
   - `OPENBRAIN_ITEM_URL_TEMPLATE` - Template for OpenBrain item link in summary messages, supports `{id}` and `{url}` placeholders

4. **Set up the database:**

   ```bash
   npm run db:migrate
   ```

5. **Run the bot:**

   ```bash
   npm run start:dev
   ```

## Scripts

- `npm run start:dev` - Run bot in watch mode with TypeScript
- `npm run build` - Compile TypeScript into `dist/`
- `npm run start` - Run compiled bot from `dist/`
- `npm run lint` - Type check without emitting files
- `npm run test` - Run unit tests
 - `npm run test:coverage` - Run tests with coverage and enforce >=80% coverage for the bot/ module
- `npm run db:migrate` - Apply SQL migrations to PostgreSQL

## CLI Commands

The bot provides a CLI tool for database operations outside of Discord:

### Installation

After building the project, the `sb` command is available:

```bash
npm run build
# Option 1: Use npx
npx sb <command>

# Option 2: Link globally
npm link
sb <command>
```

### Commands

#### `sb add` - Add URLs directly to the database

Process URLs immediately (bypasses the queue):

```bash
# Add single URL
sb add https://example.com/article

# Add multiple URLs
sb add https://url1.com https://url2.com https://url3.com

# Add with verbose progress output
sb add --verbose https://example.com
```

**Features:**
- Extracts content, generates summary and embedding immediately
- Shows progress: `Downloading → Extracting → Summarizing → Embedding → Storing → Completed`
- Outputs: `Added: <title> (ID: <id>)` on success, `Failed: <url> - <error>` on failure
- Supports YouTube URLs with transcript extraction
- Exit codes: 0 (success), 1 (error), 2 (invalid args)

#### `sb queue` - Queue URLs for later processing

Add URLs to the processing queue (processed by the bot asynchronously):

```bash
# Queue single URL
sb queue https://example.com/article

# Queue multiple URLs
sb queue https://url1.com https://url2.com https://url3.com

# Queue with verbose output
sb queue --verbose https://example.com
```

**Features:**
- Inserts URLs into `document_queue` with `pending` status
- URLs processed sequentially by the bot
- Discord notifications sent to the configured channel on progress/completion
- Outputs: `Queued: <url> (ID: <id>)` on success
- Exit codes: 0 (success), 1 (error), 2 (invalid args)

#### `sb search` - Search indexed content

Search the database using semantic similarity:

```bash
# Basic search (table output)
sb search "machine learning"

# JSON output for programmatic use
sb search --format json "neural networks"

# Get just the URLs
sb search --format urls-only "web development" | xargs -I {} curl {}

# Limit results
sb search --limit 10 "artificial intelligence"
```

**Features:**
- Semantic search using vector embeddings
- Results sorted by relevance
- Exit codes: 0 (success), 1 (error), 2 (invalid args)

#### `sb stats` - Database statistics

Display statistics about the indexed content:

```bash
# Table output (default)
sb stats

# JSON output
sb stats --format json
```

**Features:**
- Total links count
- Links with summaries, embeddings, content, transcripts
- Recent activity (24h, 7d, 30d)
- Exit codes: 0 (success), 1 (error), 2 (invalid args)

### Progress Output Formats (add command)

The `sb add` command supports multiple output formats for progress events:

```bash
# Console format (human-friendly, default in TTY)
sb add https://example.com/article

# NDJSON format (one JSON line per event, ideal for automation)
sb add --format ndjson https://example.com/article
sb add --ndjson https://example.com/article  # shorthand

# Webhook format (POSTs events to URL)
sb add --format webhook --webhook-url https://example.com/hook https://example.com/article
```

**NDJSON Output Example:**
```bash
$ sb add --ndjson https://example.com/article
{"type":"progress","phase":"downloading","url":"https://example.com/article","current":1,"total":1,"timestamp":"2026-03-29T12:00:00.000Z"}
{"type":"progress","phase":"extracting_links","url":"https://example.com/article","current":1,"total":1,"timestamp":"2026-03-29T12:00:01.000Z"}
{"type":"progress","phase":"summarizing","url":"https://example.com/article","current":1,"total":1,"chunkCurrent":1,"chunkTotal":3,"timestamp":"2026-03-29T12:00:02.000Z"}
{"type":"progress","phase":"completed","url":"https://example.com/article","current":1,"total":1,"title":"Example Article","summary":"This is a summary...","timestamp":"2026-03-29T12:00:05.000Z"}
```

**Webhook Events:**
When using `--format webhook`, each progress event is POSTed as JSON to the provided URL. The webhook receives the same JSON structure as NDJSON output.

### Context Tags for Bot Integration

When the Discord bot invokes OpenBrain CLI commands, it passes Discord context as metadata tags:

```bash
ob add \
  --tag "discord_channel_id:123456789" \
  --tag "discord_message_id:987654321" \
  --tag "discord_author_id:111222333" \
  https://example.com/article
```

These tags associate operations with Discord entities for traceability while remaining valid OpenBrain CLI arguments.

### Automatic Summary Posting

After a successful URL add, the bot can call `ob summary <url>` and post the generated summary into the processing thread (or a configured fallback channel).

- Retries summary generation up to 3 times with exponential backoff
- Includes metadata in the message: OpenBrain item link, source URL, item id, author, timestamp
- Uses item-id deduplication in-process to avoid posting duplicate summaries
- Posts a manual-review notice if summary generation fails after retries

### Global Options

All commands support:
- `--help, -h` - Show usage information
- `--version, -v` - Show version
- `--verbose` - Enable detailed JSON logging output

### Environment Requirements

CLI commands operate independently of Discord and require only:

**Required:**
- `DATABASE_URL` - PostgreSQL connection string

**Required for `add` command:**
- `LLM_BASE_URL` - LLM API endpoint (e.g., `http://localhost:11434/v1`)
- `LLM_MODEL` - Model name (e.g., `gpt-4o-mini`)

**Optional:**
- `LLM_EMBEDDING_MODEL` - Separate model for embeddings
- `YOUTUBE_API_KEY` - For YouTube metadata extraction
- `LOG_LEVEL` - Control verbosity (`debug`, `info`, `warn`, `error`)

**Note:** The CLI does NOT require `DISCORD_BOT_TOKEN` or `DISCORD_CHANNEL_ID`. These are bot-only variables.

## YouTube Ingestion

The bot provides enhanced support for YouTube URLs with the following features:

### Supported URL Formats

- Standard: `https://youtube.com/watch?v=VIDEO_ID`
- Short: `https://youtu.be/VIDEO_ID`
- Shorts: `https://youtube.com/shorts/VIDEO_ID`
- Live: `https://youtube.com/live/VIDEO_ID`
- Embed: `https://youtube.com/embed/VIDEO_ID`
- Mobile: `https://m.youtube.com/watch?v=VIDEO_ID`
- Music: `https://music.youtube.com/watch?v=VIDEO_ID`

### Features

1. **Metadata Extraction** (requires `YOUTUBE_API_KEY`):
   - Video title and description
   - Channel name
   - Published date
   - Thumbnail (highest quality available)

2. **Caption/Transcript Fetching** (optional):
   - Automatic caption download when available
   - Language fallback: preferred → English → any
   - Auto-generated caption detection
   - Stored in `transcript` field for LLM processing

3. **LLM Enhancement**:
   - Summaries generated from transcript when available (better quality)
   - Embeddings use transcript text for semantic search
   - Fallback to metadata when captions unavailable

4. **Rate Limiting**:
   - Exponential backoff on YouTube API rate limits
   - Retry-After header support
   - Max 3 retries per request

### Setup

1. Get a YouTube Data API v3 key:
   - Visit [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Create a new project or select existing
   - Enable "YouTube Data API v3"
   - Create credentials → API Key
   - Copy the key to `YOUTUBE_API_KEY` in `.env`

2. Configure caption preferences:
   ```env
   YOUTUBE_CAPTION_LANGUAGE=en
   ENABLE_YOUTUBE_CAPTIONS=true
   ```

### Troubleshooting

**Issue**: YouTube URLs not being processed
- Check `YOUTUBE_API_KEY` is set correctly
- Verify API key has YouTube Data API v3 enabled
- Check logs for quota exceeded errors

**Issue**: Captions not being fetched
- Not all videos have captions (especially non-English)
- Check `ENABLE_YOUTUBE_CAPTIONS=true` in `.env`
- Verify video has captions available on YouTube

**Issue**: Rate limit errors
- YouTube API has quota limits (10,000 units/day for free tier)
- Bot implements exponential backoff automatically
- Consider caching or reducing ingestion frequency

## Backfill Queue

Failed operations (embeddings, summaries, transcripts) are automatically queued for retry:

- **Queue Table**: `backfill_queue` tracks pending items
- **SLA**: 24-hour maximum from creation to completion
- **Retry Logic**: Up to 3 attempts with exponential backoff
- **Processing**: Hourly by default (configurable via `BACKFILL_INTERVAL_MS`)
- **Metrics**: Track queue depth, success rate, SLA violations

### Configuration

```env
BACKFILL_INTERVAL_MS=3600000  # 1 hour in milliseconds
MAX_BACKFILL_ATTEMPTS=3       # Max retry attempts
```

## Database

The storage layer uses PostgreSQL with pgvector:

- `migrations/001_initial_schema.sql` - Core tables and indexes
- `migrations/003_add_transcript_column.sql` - YouTube transcript support
- `migrations/004_backfill_queue.sql` - Backfill queue tracking

Key tables:
- `links` - Stored links with metadata, summaries, embeddings
- `backfill_queue` - Pending retry operations
- `app_checkpoints` - Processing state per channel

## Ingestion Pipeline

1. **URL Detection** (`src/ingestion/url.ts`):
   - Extract URLs from Discord messages
   - Detect YouTube URLs and normalize to canonical format

2. **Content Extraction**:
   - YouTube: Fetch metadata via YouTube Data API
   - Generic: Use `@extractus/article-extractor`
   - Captions: Download via youtube-transcript

3. **LLM Processing**:
   - Generate summary (using transcript if available)
   - Create embedding vector for semantic search

4. **Storage**:
   - Upsert to PostgreSQL with pgvector
   - Update backfill queue on failures
   - React to Discord message with success/failure emoji

## Observability

### Logging

Structured logging throughout the pipeline:
- `ingestion.youtube` - YouTube-specific operations
- `ingestion.backfill` - Queue processing
- `llm.*` - LLM operations
- `db.*` - Database operations

Set `LOG_LEVEL` to control verbosity:
- `error` - Errors only
- `warn` - Warnings and errors
- `info` - Standard operational logs (default)
- `debug` - Verbose debugging

### Metrics

The backfill service tracks:
- Queue depth (pending items)
- Processed today
- Failed today
- SLA violations

Access via `BackfillService.getMetrics()`

## Architecture

```
Discord Message
    ↓
URL Extraction (youtube.ts, url.ts)
    ↓
Content Fetch (YouTube API / Article Extractor)
    ↓
LLM Processing (summarize + embed)
    ↓
PostgreSQL + pgvector
    ↓
Discord Reaction
```

## Testing

Run the test suite:

```bash
npm test
```

Test coverage includes:
- URL extraction and normalization
- YouTube API client (mocked)
- Caption fetching (mocked)
- Backfill queue operations
- Database repository

## Contributing

We welcome contributions from the community! Here's how to get started:

### Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and configure your environment
4. Run tests to ensure everything works: `npm test`

### Making Changes

1. Create a feature branch: `git checkout -b feature/your-feature-name`
2. Make your changes following the existing code style
3. Add tests for new functionality
4. Run the test suite: `npm test`
5. Run linting: `npm run lint`
6. Commit your changes with clear, descriptive messages

### Pull Request Process

1. Push your branch to your fork
2. Open a Pull Request against the `main` branch
3. Describe what your PR does and why
4. Ensure all tests pass and the PR is up to date with `main`

### Code Style

- Follow TypeScript best practices
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small
- Write tests for new features

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
