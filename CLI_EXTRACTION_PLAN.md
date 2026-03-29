# CLI Extraction Plan

## Overview

This document outlines the plan for extracting the CLI into its own repository while keeping the Discord bot functional.

**Key Change:** Move CLI-only libraries into `src/cli/` folder BEFORE refactoring to open source alternatives. This allows immediate CLI extraction without waiting for library replacements.

## Library Ownership

### Shared Libraries (Used by BOTH CLI and Bot)
These remain in shared locations and may be refactored to open source:

| Library | Current Location | Used By | Action |
|---------|-----------------|---------|---------|
| **pino** | `src/logger.ts` | CLI + Bot | Refactor to open source (HIGH priority) |
| **zod** | `src/config/cli.ts` | CLI + Bot | Refactor config validation (HIGH priority) |

### CLI-Only Libraries (Move to `src/cli/` folder)
These are used ONLY by the CLI and should be moved into the CLI folder structure immediately:

| Library | Current Location | CLI Only | Action |
|---------|-----------------|----------|---------|
| **openai** | `src/llm/client.ts` | ✅ Yes | Move to `src/cli/lib/llm/` - refactor later |
| **@qdrant/js-client-rest** | `src/vector/qdrant-store.ts` | ✅ Yes | Move to `src/cli/lib/vector/` - refactor later |
| **pgvector** | Repository layer | ✅ Yes | Move to `src/cli/lib/db/` - refactor later |
| **pg** | `src/db/client.ts` | ✅ Yes | Move to `src/cli/lib/db/` - refactor later |
| **@extractus/article-extractor** | `src/ingestion/extractor.ts` | ✅ Yes | Move to `src/cli/lib/ingestion/` - refactor later |

## Two-Phase Approach

### Phase 1: Move CLI-Only Libraries (IMMEDIATE)
**Goal:** Enable CLI extraction without refactoring

1. Create `src/cli/lib/` directory structure
2. Move CLI-only modules into `src/cli/lib/`
3. Update all imports within CLI
4. Bot continues to invoke CLI via subprocess (no changes needed)
5. **No refactoring** - keep current implementations

**CLI Folder Structure After Move:**
```
src/cli/
  commands/           # CLI commands
  presenters/         # Progress presenters
  lib/                # NEW: CLI-only libraries
    llm/
      client.ts       # Moved from src/llm/
    vector/
      qdrant-store.ts # Moved from src/vector/
    db/
      client.ts       # Moved from src/db/
      repository.ts   # Moved from src/db/
      queue-repository.ts # Moved from src/db/
    ingestion/
      service.ts      # Moved from src/ingestion/
      extractor.ts    # Moved from src/ingestion/
      youtube.ts      # Moved from src/ingestion/
      url.ts          # Moved from src/ingestion/
  config/
    cli.ts            # CLI config (shared with bot via subprocess)
```

**Benefits:**
- CLI can be extracted to separate repo immediately
- Bot repo becomes lightweight (only Discord code + subprocess runner)
- No shared modules to manage between repos
- No git submodules needed

### Phase 2: Refactor to Open Source Libraries (FUTURE)
**Goal:** Replace custom implementations with open source packages

After CLI extraction, refactor each CLI-only library:
1. Replace custom LLM client with `openai` npm package
2. Replace Qdrant wrapper with `@qdrant/js-client-rest`
3. Replace logger with `pino` (already HIGH priority)
4. Improve pgvector integration with `pgvector` npm package
5. Simplify database client

**Benefits:**
- Can refactor independently in CLI repo
- No impact on Bot repo
- Can take time to do each replacement properly

## Current Structure

### CLI Location
- `src/cli/` - CLI source code
- `tests/cli/` - CLI tests  
- `src/config/cli.ts` - CLI configuration (shared with Bot via subprocess)

### Shared Modules (Will remain after move)
**Post-Move Shared Modules:**
- `src/config/cli.ts` - CLI config schema (Bot reads, CLI uses)
- `src/logger.ts` - Logger (HIGH priority: refactor to pino)
- `src/interfaces/cli-types.ts` - Type definitions
- `src/bot/cli-runner.ts` - Subprocess runner (Bot only)

## Extraction Strategy

### Immediate Extraction (After Phase 1)
1. Create new repo `sourcebase-cli`
2. Copy `src/cli/` (includes all CLI code + libraries)
3. Copy `src/config/cli.ts` and `src/interfaces/cli-types.ts` (shared types)
4. Copy `tests/cli/`
5. Copy migrations schema
6. Bot repo removes `src/cli/` folder
7. Both repos have independent package.json

**Result:**
- CLI repo: Self-contained with all its dependencies
- Bot repo: Minimal (Discord + subprocess runner + shared logger/config)
- No shared modules or submodules needed
- Bot invokes CLI via `npm exec sourcebase-cli` or direct binary

## Pre-Extraction Checklist

### Phase 1: Move CLI Libraries
- [ ] Create `src/cli/lib/` directory
- [ ] Move `src/llm/client.ts` to `src/cli/lib/llm/`
- [ ] Move `src/vector/qdrant-store.ts` to `src/cli/lib/vector/`
- [ ] Move `src/db/client.ts`, `repository.ts`, `queue-repository.ts` to `src/cli/lib/db/`
- [ ] Move `src/ingestion/service.ts`, `extractor.ts`, `youtube.ts`, `url.ts` to `src/cli/lib/ingestion/`
- [ ] Update all imports within CLI to use relative paths
- [ ] Verify CLI still builds and tests pass
- [ ] Verify Bot still works via subprocess

### Phase 2: Refactor (Post-Extraction)
- [ ] Replace LLM client with `openai` npm package
- [ ] Replace Qdrant wrapper with `@qdrant/js-client-rest`
- [ ] Replace logger with `pino` (HIGH priority - affects Bot)
- [ ] Improve pgvector integration
- [ ] Simplify database client

## Post-Extraction Structure

### CLI Repository (`sourcebase-cli`)
```
src/
  cli/
    commands/           # CLI commands
    presenters/         # Progress presenters
    lib/                # CLI-only libraries
      llm/
        client.ts       # Will be refactored to openai
      vector/
        qdrant-store.ts # Will be refactored to @qdrant/js-client-rest
      db/
        client.ts       # Will be simplified
        repository.ts   # May keep or replace with ORM
        queue-repository.ts
      ingestion/
        service.ts      # Core orchestration (keep)
        extractor.ts    # May keep or replace
        youtube.ts      # May keep or replace
    config/
      cli.ts            # CLI config
  interfaces/
    cli-types.ts        # Shared types
  logger.ts             # Will be refactored to pino
tests/
  cli/                  # CLI tests
migrations/
  001_initial_schema.sql
package.json            # All CLI dependencies
```

### Bot Repository (`sourcebase` - This Repo)
```
src/
  bot/                  # Bot subprocess runner
    cli-runner.ts       # Invokes CLI as subprocess
  config/
    bot.ts              # Bot config (extends CLI config)
    cli.ts              # CLI config schema (copied from CLI repo)
  interfaces/
    cli-types.ts        # Shared types (copied from CLI repo)
  logger.ts             # Logger (HIGH priority: refactor to pino)
  discord/              # Discord-specific code
  index.ts              # Bot entrypoint
tests/
  bot/                  # Bot tests
  boundary.test.ts      # Boundary enforcement
  config/               # Config tests
package.json            # Minimal dependencies (discord.js, pino, zod)
```

## Migration Steps

### Phase 1: Move CLI Libraries (IMMEDIATE - NO REFACTORING)

1. **Create CLI lib directory**
   ```bash
   mkdir -p src/cli/lib/{llm,vector,db,ingestion}
   ```

2. **Move files** (preserving git history with `git mv`)
   ```bash
   git mv src/llm/client.ts src/cli/lib/llm/
   git mv src/vector/qdrant-store.ts src/cli/lib/vector/
   git mv src/db/client.ts src/cli/lib/db/
   git mv src/db/repository.ts src/cli/lib/db/
   git mv src/db/queue-repository.ts src/cli/lib/db/
   git mv src/ingestion/service.ts src/cli/lib/ingestion/
   git mv src/ingestion/extractor.ts src/cli/lib/ingestion/
   git mv src/ingestion/youtube.ts src/cli/lib/ingestion/
   git mv src/ingestion/url.ts src/cli/lib/ingestion/
   ```

3. **Update imports** within CLI to use relative paths
   - Change `from "../../llm/client.js"` to `from "../lib/llm/client.js"`
   - Change `from "../../db/repository.js"` to `from "../lib/db/repository.js"`
   - etc.

4. **Verify builds**
   ```bash
   npm run build
   npm test
   ```

5. **Commit**
   ```bash
   git commit -m "Move CLI-only libraries into src/cli/lib/"
   ```

### Phase 2: Create CLI Repo (After Move)

1. Create new repo `sourcebase-cli`
2. Copy files from current repo:
   - `src/cli/` → `src/`
   - `src/config/cli.ts` → `src/config/cli.ts`
   - `src/interfaces/cli-types.ts` → `src/interfaces/cli-types.ts`
   - `src/logger.ts` → `src/logger.ts` (temporarily)
   - `tests/cli/` → `tests/`
   - `migrations/` → `migrations/`
   - `package.json` → `package.json` (modify for CLI-only)

3. Update CLI package.json:
   - Remove Discord-related dependencies
   - Keep all CLI dependencies
   - Update bin entry

4. Remove CLI from Bot repo:
   ```bash
   rm -rf src/cli/
   rm -rf tests/cli/
   ```

5. Update Bot to use CLI via npm/npx:
   - Update `src/bot/cli-runner.ts` to use `npx sourcebase-cli`
   - Or add as dependency and use `node_modules/.bin/sb`

### Phase 3: Refactor Libraries (Post-Extraction)

In the CLI repo only:
1. Replace LLM client with `openai` npm package
2. Replace Qdrant wrapper with `@qdrant/js-client-rest`
3. Replace logger with `pino` (requires sync with Bot repo)
4. Improve pgvector integration
5. Simplify database client

## Notes

- **Move first, refactor later** - This enables immediate CLI extraction
- **CLI intentionally contains all its dependencies** after move - this is correct
- **No shared modules** - Bot only needs logger and config types
- **Git submodule not needed** - Cleaner separation
- **Bot repo becomes minimal** - Only Discord code + subprocess runner
- **Refactoring can happen later** - In CLI repo independently

## Work Items

See child work items of SB-0MNBSCZDC0021Q2J (Refactor for Libraries epic):

**Immediate (Move without refactoring):**
- Create task to move libraries into src/cli/lib/

**High Priority (Shared libraries):**
- Replace logger with pino (SB-0MNBSDUQE008P7CU)
- Improve config validation with zod (SB-0MNBSEQ4T002G2QT)

**Future (CLI-only, refactor after extraction):**
- Replace LLM client with openai (SB-0MNBSDEV8000N7GA)
- Replace Qdrant wrapper (SB-0MNBSDN010091ST9)
- Improve pgvector integration (SB-0MNBSEABT007T6E2)
- Simplify database client (SB-0MNBSEHU1001WJTR)
