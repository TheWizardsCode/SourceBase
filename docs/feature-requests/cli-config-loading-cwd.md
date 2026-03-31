# Feature Request: CLI Configuration Loading from Installation Directory

## Problem

The CLI's `dotenv.config()` call loads `.env` from the current working directory (cwd), not from the CLI's installation directory. When spawned as a subprocess by the Discord bot, the cwd is the bot's directory, not the CLI's directory.

## Current Implementation

In `dist/src/config/cli.js`:
```javascript
import dotenv from "dotenv";
dotenv.config();  // Loads from cwd, not from CLI directory
```

## Issue Details

1. **Discord bot runs from**: `/home/rgardler/projects/SourceBase`
2. **CLI installed at**: `/usr/bin/sb` (symlinked to `dist/src/cli/index.js`)
3. **CLI looks for .env in**: cwd = `/home/rgardler/projects/SourceBase`
4. **The .env file exists but is in YAML format**, not KEY=value format
5. **Result**: `DATABASE_URL` is never loaded

## Expected Behavior

The CLI should look for its configuration in its own directory or standard config locations, not depend on the cwd.

## Suggested Fix

Load `.env` from the CLI's own directory:

```javascript
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from CLI's directory (2 levels up from config/cli.js)
dotenv.config({ 
  path: path.resolve(__dirname, '..', '..', '.env') 
});
```

Or support multiple config locations in order of priority:
1. `~/.config/openbrain/config.yaml` (already exists!)
2. CLI installation directory `.env`
3. Current working directory `.env` (fallback)

## Workaround

For now, the Discord bot must either:
1. Change cwd to CLI directory before spawning (not ideal)
2. Include `DATABASE_URL` in bot's environment (creates coupling)
3. Convert `.env` file to KEY=value format in bot directory

## Acceptance Criteria

- [ ] CLI loads configuration from its own installation directory
- [ ] CLI falls back to standard config locations (`~/.config/openbrain/`)
- [ ] CLI works correctly regardless of where it's spawned from
- [ ] No dependency on parent's cwd or environment

## Related

- Previous feature request: CLI-CONFIG-001
- Epic: SB-0MNEHNGJX0060FM71
