# CLI Extraction Plan

## Overview
This document outlines the plan for extracting the CLI into its own repository while keeping the Discord bot functional.

## Current Structure

### CLI Location
- `src/cli/` - CLI source code
- `tests/cli/` - CLI tests
- `src/config/cli.ts` - CLI configuration (Discord-free)

### CLI Dependencies (Shared Modules)
The CLI depends on these shared modules that must remain accessible:

**Database Layer:**
- `src/db/client.ts` - Database connection pool
- `src/db/repository.ts` - Link repository
- `src/db/queue-repository.ts` - Queue repository

**Ingestion Layer:**
- `src/ingestion/service.ts` - Core ingestion service
- `src/ingestion/extractor.ts` - Content extraction
- `src/ingestion/youtube.ts` - YouTube API client
- `src/ingestion/url.ts` - URL utilities

**LLM Layer:**
- `src/llm/client.ts` - LLM API client

**Utilities:**
- `src/logger.ts` - Structured logging
- `src/interfaces/cli-types.ts` - Shared type definitions
- `src/vector/qdrant-store.ts` - Vector store (optional)

## Extraction Strategy

### Option A: Git Submodule (Recommended)
1. Create new repo `sourcebase-cli`
2. Move `src/cli/`, `src/config/cli.ts`, `tests/cli/` to new repo
3. Add bot repo as git submodule in `vendor/bot` or similar
4. Update CLI imports to use `../vendor/bot/src/...`
5. Both repos maintain independent package.json but share code

### Option B: NPM Link / Workspace
1. Keep both in same repo as workspaces (monorepo)
2. Or use npm link for local development
3. Publish shared modules as separate package

### Option C: Duplicate Shared Code
1. Copy shared modules to CLI repo
2. Maintains complete independence
3. Requires keeping copies in sync

## Pre-Extraction Checklist

### ✅ CLI Code
- [x] No discord.js imports in src/cli/**
- [x] No DISCORD_* env var references in CLI code
- [x] Uses neutral types from src/interfaces/cli-types.ts
- [x] All CLI-specific config in src/config/cli.ts

### ✅ Shared Modules (Discord-Free)
- [x] src/db/client.ts - Clean
- [x] src/db/repository.ts - Clean
- [x] src/db/queue-repository.ts - Clean
- [x] src/ingestion/service.ts - Clean
- [x] src/ingestion/extractor.ts - Clean
- [x] src/ingestion/youtube.ts - Clean
- [x] src/ingestion/url.ts - Clean
- [x] src/llm/client.ts - Clean
- [x] src/logger.ts - Clean
- [x] src/interfaces/cli-types.ts - Clean

### ✅ Bot Code
- [x] No direct imports from src/cli/ (except types, moved to interfaces)
- [x] Uses subprocess calls via src/bot/cli-runner.ts
- [x] src/config/bot.ts extends cli config

### ✅ Tests
- [x] tests/cli/ - Self-contained CLI tests
- [x] tests/boundary.test.ts - Validates separation

### ✅ Database
- [x] Migrations use neutral column names
- [x] Single consolidated schema file

## Post-Extraction Structure

### CLI Repository (`sourcebase-cli`)
```
src/
  cli/              # From original src/cli/
  config/
    cli.ts          # From original src/config/cli.ts
  db/               # Symlink or submodule to bot/src/db/
  ingestion/        # Symlink or submodule to bot/src/ingestion/
  llm/              # Symlink or submodule to bot/src/llm/
  interfaces/       # Symlink or submodule to bot/src/interfaces/
  logger.ts         # Symlink or submodule to bot/src/logger.ts
  vector/           # Symlink or submodule to bot/src/vector/
tests/
  cli/              # From original tests/cli/
migrations/
  001_initial_schema.sql  # Copy of schema
package.json
```

### Bot Repository (`sourcebase` - This Repo)
```
src/
  bot/              # Bot subprocess runner
  config/
    bot.ts          # Bot config (extends CLI config)
  db/               # Database layer
  discord/          # Discord-specific code
  ingestion/        # Ingestion service
  llm/              # LLM client
  interfaces/       # Shared interfaces
  logger.ts         # Logger
  vector/           # Vector store
  index.ts          # Bot entrypoint
tests/
  bot/              # Bot tests
  config/           # Config tests
  boundary.test.ts  # Boundary enforcement
  # ... other tests
migrations/
  001_initial_schema.sql
package.json
  # Remove "sb" bin entry
```

## Migration Steps

### Phase 1: Prepare Bot Repo (This PR)
1. ✅ Ensure all shared modules are Discord-free
2. ✅ Move shared types to src/interfaces/
3. ✅ Consolidate migrations
4. ✅ Remove CLI bin from package.json (post-extraction)

### Phase 2: Create CLI Repo
1. Create new repo `sourcebase-cli`
2. Copy CLI files: `src/cli/`, `src/config/cli.ts`, `tests/cli/`
3. Copy migrations schema
4. Set up git submodule pointing to bot repo
5. Update imports in CLI to use submodule path
6. Create CLI-specific package.json

### Phase 3: Verify Separation
1. Build CLI repo independently
2. Build bot repo without CLI folder
3. Run boundary tests
4. Test subprocess communication

## Notes

- The CLI **intentionally** depends on shared modules (db, ingestion, llm)
- This is correct architecture - DRY principle
- The shared modules are already Discord-free
- Extraction requires either git submodule or code duplication
- Git submodule is recommended to maintain single source of truth

## Files That Must Move With CLI

**CLI-Specific (Move to new repo):**
- src/cli/**
- src/config/cli.ts
- tests/cli/**

**Shared (Keep in bot repo, access via submodule):**
- src/db/**
- src/ingestion/*.ts (except queue.ts and startup-recovery.ts which have discord imports)
- src/llm/**
- src/interfaces/**
- src/logger.ts
- src/vector/**

**Discord-Specific (Stay in bot repo):**
- src/discord/**
- src/bot/**
- src/index.ts
- src/ingestion/queue.ts (imports discord.js)
- src/ingestion/startup-recovery.ts (imports discord.js)
- tests/bot/**
- tests/boundary.test.ts
