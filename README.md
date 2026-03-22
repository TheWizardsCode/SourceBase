# Discord Link Aggregation Bot

TypeScript Discord bot scaffold for monitoring a channel and indexing shared links.

## Requirements

- Node.js 20+
- npm 10+

## Local setup

1. Install dependencies:

   `npm install`

2. Copy environment template:

   `cp .env.example .env`

3. Fill in required values in `.env`:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`
- `DATABASE_URL`
- `LLM_BASE_URL`
- `LLM_MODEL`

## Scripts

- `npm run start:dev` - Run bot in watch mode with TypeScript.
- `npm run build` - Compile TypeScript into `dist/`.
- `npm run start` - Run compiled bot from `dist/`.
- `npm run lint` - Type check without emitting files.
- `npm run test` - Run unit tests.
- `npm run db:migrate` - Apply SQL migrations to the configured PostgreSQL database.

## Current status

This repository currently provides:

- Environment-based configuration loading and validation
- Discord client bootstrap with monitored channel filtering
- Basic structured logger utility
- Initial unit tests for logger behavior
- URL extraction from Discord messages
- Article extraction using `@extractus/article-extractor`
- Ingestion flow with DB upsert and failure reactions

Further work for link extraction, database persistence, LLM integration, and semantic search is tracked in child work items under the parent epic.

## Database

The storage layer uses PostgreSQL with pgvector and includes:

- `migrations/001_initial_schema.sql` to create `links`, `app_checkpoints`, and indexes
- `src/db/migrate.ts` migration runner with a `schema_migrations` table
- `src/db/repository.ts` repository helpers for:
  - link upsert-by-URL (duplicate handling)
  - link lookup by URL
  - save/load checkpoint by Discord channel

## Ingestion pipeline

- URL detection uses `src/ingestion/url.ts`
- Content extraction uses `src/ingestion/extractor.ts` (`@extractus/article-extractor`)
- Ingestion orchestration uses `src/ingestion/service.ts`
- On extraction/storage failure, the bot reacts to the source message with `INGEST_FAILURE_REACTION`

## LLM integration

- LLM proxy client in `src/llm/client.ts` supports:
  - summary generation via chat completions
  - embedding generation via embeddings endpoint
  - configurable retries (`LLM_MAX_RETRIES`, `LLM_RETRY_DELAY_MS`)
- Ingestion now stores both generated summary and embedding vectors for extracted links
