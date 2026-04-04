/**
 * Test helpers to temporarily override OB_CLI_PATH (and related keys)
 * and ensure the environment and cli-runner internal state are restored.
 */
export type EnvSnapshot = { OB_CLI_PATH?: string; SB_CLI_PATH?: string };

/**
 * Synchronously set OB_CLI_PATH and attempt to update cli-runner internal state.
 * Returns a restore function that will reset environment and cli-runner state.
 */
export function setObCliPath(path?: string): () => void {
  const prev: EnvSnapshot = { OB_CLI_PATH: process.env.OB_CLI_PATH, SB_CLI_PATH: process.env.SB_CLI_PATH };

  if (path === undefined) delete process.env.OB_CLI_PATH;
  else process.env.OB_CLI_PATH = String(path);

  // Try to update cli-runner internal state if available. This is best-effort
  // and will not throw if the module isn't loaded yet.
  try {
    // Importing here is intentionally using a dynamic import so tests that
    // haven't loaded the module yet are unaffected until they do so.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // (use dynamic import to keep ESM compatibility)
    // Note: we don't await here because setObCliPath is synchronous; instead
    // try to access module synchronously via require if possible.
    // In ESM environments this will be a no-op and is caught below.
    // @ts-ignore - allow require in test helper runtime
    const mod = typeof require === "function" ? require("../../src/bot/cli-runner.js") : null;
    if (mod && typeof mod.setCliPath === "function") {
      mod.setCliPath(process.env.OB_CLI_PATH || undefined);
    }
  } catch {
    // ignore - best-effort only
  }

  return () => {
    // restore environment
    if (prev.OB_CLI_PATH === undefined) delete process.env.OB_CLI_PATH; else process.env.OB_CLI_PATH = prev.OB_CLI_PATH;
    if (prev.SB_CLI_PATH === undefined) delete process.env.SB_CLI_PATH; else process.env.SB_CLI_PATH = prev.SB_CLI_PATH;

    // Attempt to restore cli-runner internal state (best-effort)
    (async () => {
      try {
        const mod = await import("../../src/bot/cli-runner.js");
        if (mod && typeof mod.setCliPath === "function") {
          // Set to previous env value (or undefined to fall back to default)
          mod.setCliPath(prev.OB_CLI_PATH === undefined ? undefined : prev.OB_CLI_PATH);
        }
      } catch {
        // ignore
      }
    })();
  };
}

/**
 * Async helper that sets OB_CLI_PATH for the duration of the provided function
 * and restores environment and cli-runner internal state afterwards.
 */
export async function withObCliPath<T>(path: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev: EnvSnapshot = { OB_CLI_PATH: process.env.OB_CLI_PATH, SB_CLI_PATH: process.env.SB_CLI_PATH };

  // Set env
  if (path === undefined) delete process.env.OB_CLI_PATH;
  else process.env.OB_CLI_PATH = String(path);

  // Capture previous internal CLI executable if cli-runner is loaded.
  let prevCliInternal: string | undefined;
  let modImported = false;
  try {
    // Try dynamic import - it's OK if it throws, we treat as not loaded.
    // This ensures we can restore internal state if the module is present.
    const mod = await import("../../src/bot/cli-runner.js");
    modImported = true;
    if (mod && typeof mod.getCliPath === "function") {
      try {
        prevCliInternal = mod.getCliPath();
      } catch {
        prevCliInternal = undefined;
      }
    }
    if (mod && typeof mod.setCliPath === "function") {
      mod.setCliPath(process.env.OB_CLI_PATH || undefined);
    }
  } catch {
    // ignore
  }

  try {
    return await fn();
  } finally {
    // Restore internal cli-runner setting if we captured it (or attempt to)
    try {
      const mod = modImported ? await import("../../src/bot/cli-runner.js").catch(() => null) : await import("../../src/bot/cli-runner.js").catch(() => null);
      if (mod && typeof mod.setCliPath === "function") {
        mod.setCliPath(prevCliInternal === undefined ? undefined : prevCliInternal);
      }
    } catch {
      // ignore
    }

    // Restore env
    if (prev.OB_CLI_PATH === undefined) delete process.env.OB_CLI_PATH; else process.env.OB_CLI_PATH = prev.OB_CLI_PATH;
    if (prev.SB_CLI_PATH === undefined) delete process.env.SB_CLI_PATH; else process.env.SB_CLI_PATH = prev.SB_CLI_PATH;
  }
}

export default {
  setObCliPath,
  withObCliPath,
};
