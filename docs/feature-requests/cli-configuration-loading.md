# Feature Request: OpenBrain CLI Configuration Loading in Subprocess

## Summary

The OpenBrain CLI fails to load its configuration when spawned as a subprocess by the Discord bot. The CLI should be able to load its own `.env` file and configuration independently, regardless of how it is invoked.

## Problem Statement

When the Discord bot spawns the OpenBrain CLI as a subprocess using `child_process.spawn()`, the CLI fails with the following error:

```
Configuration validation failed

Missing required environment variables:

  DATABASE_URL
    Description: PostgreSQL connection string
    Example: postgresql://user:pass@localhost:5432/dbname
```

This happens even when the CLI has its own `.env` file in its working directory.

## Current Behavior

1. The Discord bot spawns the CLI: `sb add --format ndjson <url>`
2. The CLI subprocess inherits the parent's environment variables
3. If `DATABASE_URL` is not in the parent's environment, the CLI fails
4. The CLI does not appear to load its own `.env` file when running as a subprocess

## Expected Behavior

The CLI should:
1. Load its own configuration from its `.env` file or other config sources
2. Work correctly when spawned as a subprocess, independent of the parent's environment
3. Not require the parent process (Discord bot) to know about or pass CLI-specific configuration

## Impact

This creates an unwanted tight coupling between the Discord bot and the CLI:
- The bot must know about CLI-specific configuration (`DATABASE_URL`)
- The bot's `.env` file must include variables the bot doesn't use
- Changes to CLI configuration requirements break the bot

## Use Case

**As a** Discord bot developer  
**I want** to spawn the OpenBrain CLI as a subprocess without managing its configuration  
**So that** the bot and CLI can evolve independently with loose coupling

## Proposed Solution

The CLI should ensure it can load its own configuration by:

1. **Explicitly loading `.env` from the CLI's own directory** (not relying on cwd)
2. **Checking for config files in standard locations** (e.g., `~/.config/openbrain/`)
3. **Having sensible defaults or clear error messages** when config is missing

Example implementation:
```javascript
// In CLI entry point
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from CLI's directory, not cwd
dotenv.config({ path: path.join(__dirname, '..', '.env') });
```

## Acceptance Criteria

- [ ] CLI loads its own `.env` file when spawned as a subprocess
- [ ] CLI works correctly when the parent process doesn't have `DATABASE_URL` set
- [ ] CLI configuration is independent of the spawning process
- [ ] No changes required to the Discord bot's configuration or code

## Related Work

- Discord Bot Epic: SB-0MNEHNGJX0060FM71 (Integrate 'ob add' CLI into Discord bot add command)
- Current workaround: Bot must include `DATABASE_URL` in its environment

## Priority

**High** - This is blocking proper separation of concerns between the Discord bot and CLI components.

## Workaround

Currently, the Discord bot must include `DATABASE_URL` in its `.env` file even though it doesn't use it, just so it gets passed to the CLI subprocess.

---

**Requested by:** Discord Bot Development Team  
**Date:** 2026-03-31  
**Feature Request ID:** CLI-CONFIG-001
