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

## Current status

This repository currently provides:

- Environment-based configuration loading and validation
- Discord client bootstrap with monitored channel filtering
- Basic structured logger utility
- Initial unit tests for logger behavior

Further work for link extraction, database persistence, LLM integration, and semantic search is tracked in child work items under the parent epic.
