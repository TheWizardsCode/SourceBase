/**
 * CLI Subprocess Runner
 *
 * This module provides utilities to spawn the `sb` CLI as a subprocess
 * and parse its NDJSON output for Discord bot consumption.
 *
 * @module bot/cli-runner
 * @example
 * ```typescript
 * import { runAddCommand, runQueueCommand, runStatsCommand } from "./cli-runner";
 *
 * // Add a URL with progress tracking
 * for await (const event of runAddCommand("https://example.com", {
 *   channelId: "123",
 *   messageId: "456",
 *   authorId: "789"
 * })) {
 *   console.log(event.phase, event.url);
 * }
 *
 * // Queue a URL
 * const result = await runQueueCommand("https://example.com", {
 *   channelId: "123",
 *   messageId: "456",
 *   authorId: "789"
 * });
 *
 * // Get stats
 * const stats = await runStatsCommand();
 * ```
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import path from "path";
import { normalizeUrl } from "../url.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * NDJSON progress event structure from CLI
 */
export interface AddProgressEvent {
  /** Event phase: downloading, extracting, embedding, completed, failed */
  phase: string;
  /** URL being processed */
  url: string;
  /** Optional message for failed phase */
  message?: string;
  /** Optional title for completed phase */
  title?: string;
  /** Optional timestamp */
  timestamp?: string;
  /** Optional OpenBrain item id */
  id?: number | string;
}

/**
 * Context flags for Discord bot integration
 */
export interface ContextFlags {
  /** Discord channel ID */
  channelId?: string;
  /** Discord message ID */
  messageId?: string;
  /** Discord author ID */
  authorId?: string;
}

/**
 * Runner configuration options
 */
export interface RunnerOptions extends ContextFlags {
  // RunnerOptions may also accept a transport payload directly. We keep the
  // ContextFlags fields for convenience and backwards compatibility, but
  // allow callers to pass a minimal QueueTransportPayload as the options
  // object when queueing from runtime code.
  /** Working directory for subprocess */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

/**
 * Result of add command
 */
export interface AddResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** URL that was processed */
  url: string;
  /** Error message if failed */
  error?: string;
  /** Title of the page if successful */
  title?: string;
  /** OpenBrain item id if provided by CLI events */
  id?: number;
  /** Timestamp if provided by CLI events */
  timestamp?: string;
  /** Exit code from CLI if available */
  exitCode?: number;
  /** Stderr captured from CLI if available */
  stderr?: string;
}

/**
 * Result of queue command
 */
export interface QueueResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** URL that was queued */
  url: string;
  /** Error message if failed */
  error?: string;
  /** Queue ID if successful */
  id?: number;
}

/**
 * Result of summary command
 */
export interface SummaryResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** URL that was summarized */
  url: string;
  /** Generated summary text */
  summary?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Statistics result from CLI
 */
export interface StatsResult {
  /** Total number of links in database */
  totalLinks: number;
  /** Number of processed links */
  processedCount: number;
  /** Number of pending links */
  pendingCount: number;
  /** Number of failed links */
  failedCount: number;
  /** Additional stats fields */
  [key: string]: unknown;
}

/**
 * CLI command result
 */
export interface CliCommandResult {
  /** Stdout lines */
  stdout: string[];
  /** Stderr output */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Subprocess execution result
 */
interface SubprocessResult {
  /** Exit code */
  exitCode: number;
  /** Stderr output */
  stderr: string;
}

// ============================================================================
// Child Process Tracking (for graceful shutdown)
// ============================================================================

/** Set of active child processes */
const activeChildProcesses = new Set<ChildProcess>();

/** Timeout in ms before sending SIGKILL after SIGTERM */
const SIGKILL_TIMEOUT_MS = 5000;

/**
 * Track a child process for graceful shutdown
 */
function trackChildProcess(child: ChildProcess): void {
  activeChildProcesses.add(child);
  // Remove child from tracking when it exits or emits an error to avoid
  // leaking references to failed/spawned processes (prevents orphaned
  // processes remaining in the activeChildProcesses set).
  child.on("exit", () => {
    activeChildProcesses.delete(child);
  });
  child.on("error", () => {
    activeChildProcesses.delete(child);
  });
}

/**
 * Get the number of currently active child processes
 */
export function getActiveChildProcessCount(): number {
  return activeChildProcesses.size;
}

/**
 * Terminate all active child processes gracefully
 * Sends SIGTERM first, then SIGKILL after timeout if needed
 *
 * @returns Promise that resolves when all processes have terminated
 */
export async function terminateAllChildProcesses(): Promise<void> {
  if (activeChildProcesses.size === 0) {
    return;
  }

  const children = Array.from(activeChildProcesses);
  const terminationPromises: Promise<void>[] = [];

  for (const child of children) {
    terminationPromises.push(
      new Promise((resolve) => {
        // If process already exited, resolve immediately
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }

        // Set up exit listener
        const onExit = (): void => {
          clearTimeout(sigkillTimer);
          resolve();
        };

        child.once("exit", onExit);
        child.once("error", onExit);

        // Send SIGTERM
        child.kill("SIGTERM");

        // Schedule SIGKILL after timeout
        const sigkillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, SIGKILL_TIMEOUT_MS);
      })
    );
  }

  await Promise.all(terminationPromises);
}

/**
 * Structured error from CLI subprocess
 */
export class CliRunnerError extends Error {
  /** Exit code from CLI */
  exitCode: number;
  /** Stderr output */
  stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.name = "CliRunnerError";
  }
}

/** Error thrown when stats JSON output cannot be parsed */
export class StatsParseError extends CliRunnerError {
  constructor(message: string, exitCode: number, stderr: string) {
    super(message, exitCode, stderr);
    this.name = "StatsParseError";
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * CLI executable to invoke.
 * Default is the globally-installed `ob` command, but this can be
 * overridden by the OB_CLI_PATH environment variable or by calling
 * setCliPath(path) at runtime (useful for tests).
 */
let cliExecutable = process.env.OB_CLI_PATH || "ob";

// Debug: Log which CLI executable will be invoked
console.log(`[CLI Debug] Using CLI executable: ${cliExecutable}`);
console.log(`[CLI Debug] cwd: ${process.cwd()}`);

/** Default timeout for CLI commands (5 minutes) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Core Runner Function
// ============================================================================

/**
 * Internal subprocess runner result
 */
interface RunCliSubprocessResult {
  /** The child process */
  subprocess: ChildProcess;
  /** Async iterator for stdout lines */
  stdoutIterator: AsyncGenerator<string, void, unknown>;
  /** Promise that resolves when subprocess exits */
  exitPromise: Promise<SubprocessResult>;
}

/**
 * Run a CLI command and return the subprocess
 *
 * @param command - The CLI command to run (add, queue, stats, etc.)
 * @param args - Arguments for the command
 * @param options - Options for the subprocess
 * @returns Object containing the subprocess, stdout iterator, and promise that resolves on exit
 */
function runCliSubprocess(
  command: string,
  args: string[],
  options: RunnerOptions = {}
): RunCliSubprocessResult {
  const {
    channelId,
    messageId,
    authorId,
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const supportsDiscordContextTags = command === "add" || command === "queue";

  // Build command arguments
  const cmdArgs = [command];

  // Add context tags for commands that support metadata tags.
  // OpenBrain CLI does not support --channel-id/--message-id/--author-id flags.
  if (supportsDiscordContextTags) {
    if (channelId) {
      cmdArgs.push("--tag", `discord_channel_id:${channelId}`);
    }
    if (messageId) {
      cmdArgs.push("--tag", `discord_message_id:${messageId}`);
    }
    if (authorId) {
      cmdArgs.push("--tag", `discord_author_id:${authorId}`);
    }
  }

  // Add remaining args
  cmdArgs.push(...args);

  // Resolve how we will spawn the subprocess.
  // If the configured CLI executable is a JavaScript file (e.g. a test shim),
  // spawn Node and pass the script path as the first argument. This makes it
  // easy to point OB_CLI_PATH at a local JS shim without requiring the shim
  // to be executable on disk.
  let spawnCmd: string = cliExecutable;
  let spawnArgs: (string | number)[] = cmdArgs;
  if (path.extname(String(cliExecutable)).toLowerCase() === ".js") {
    // Use the running Node executable to invoke the script
    spawnCmd = process.execPath;
    spawnArgs = [cliExecutable, ...cmdArgs];
  }

  // Debug: Log the exact command being spawned for troubleshooting
  try {
    console.log(`[CLI Debug] Spawning command: ${spawnCmd} ${spawnArgs.map((a) => String(a)).join(" ")}`);
  } catch {
    // ignore any logging issues
  }

  // Spawn the subprocess
  const subprocess = spawn(spawnCmd, spawnArgs as string[], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Track the child process for graceful shutdown
  trackChildProcess(subprocess);

  // Create readline interface for stdout
  const stdoutRl = createInterface({
    input: subprocess.stdout!,
    crlfDelay: Infinity,
  });

  // Track stderr
  let stderrBuffer = "";
  subprocess.stderr!.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    // Debug: Log stderr chunks as they arrive
    console.log(`[CLI Debug] stderr chunk: ${chunk.substring(0, 200)}`);
  });

  // Create async iterator for stdout lines
  const stdoutIterator = (async function* () {
    for await (const line of stdoutRl) {
      yield line;
    }
  })();

  // Create promise that resolves when subprocess exits
  const exitPromise = new Promise<SubprocessResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Close readline to ensure any for-await loops over stdoutIterator
      // terminate promptly when the subprocess is being killed due to
      // a timeout. This prevents the caller from being stuck waiting
      // for stdout lines while the exit promise rejects.
      try {
        stdoutRl.close();
      } catch {
        /* ignore */
      }
      subprocess.kill("SIGTERM");
      reject(
        new CliRunnerError(
          `CLI command timed out after ${timeoutMs}ms`,
          -1,
          stderrBuffer
        )
      );
    }, timeoutMs);

    subprocess.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 0,
        stderr: stderrBuffer,
      });
    });

    subprocess.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      // Ensure readline is closed to unblock stdout iteration
      try {
        stdoutRl.close();
      } catch {
        /* ignore */
      }
      // Capture spawn error details (ENOENT, EACCES, etc.) in stderrBuffer
      const code = error && (error as any).code ? (error as any).code : undefined;
      const errno = error && (error as any).errno ? (error as any).errno : undefined;
      const spawnMsg = `Failed to spawn CLI: ${error.message}${code ? ` (code=${code})` : ""}${errno ? ` (errno=${errno})` : ""}`;
      stderrBuffer += `\n[spawn error] ${spawnMsg}`;
      console.log(`[CLI Debug] spawn error: ${spawnMsg}`);
      reject(new CliRunnerError(spawnMsg, -1, stderrBuffer));
    });
  });

  return { subprocess, stdoutIterator, exitPromise };
}

// ============================================================================
// Command Runners
// ============================================================================

/**
 * Run the `sb add` command and yield progress events
 *
 * This function spawns the CLI with NDJSON format and yields progress
 * events as they occur. The final result includes success/failure status.
 *
 * @param url - URL to add
 * @param options - Context and runner options
 * @returns Async generator that yields progress events and returns final result
 * @example
 * ```typescript
 * for await (const event of runAddCommand("https://example.com", {
 *   channelId: "123",
 *   messageId: "456",
 *   authorId: "789"
 * })) {
 *   console.log(`${event.phase}: ${event.url}`);
 * }
 * ```
 */
/**
 * Extended progress event that includes the final result
 */
export type AddProgressEventWithResult = AddProgressEvent | (AddResult & { phase: "__result__" });

export async function* runAddCommand(
  url: string,
  options: RunnerOptions = {}
): AsyncGenerator<AddProgressEvent, AddResult, unknown> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "add",
    ["--format", "ndjson", url],
    options
  );

  let lastEvent: AddProgressEvent | null = null;

  try {
    // Yield progress events as they arrive. Do not overwrite lastEvent when
    // the CLI emits a progress object that lacks a `phase` field. Some CLI
    // implementations may emit informational objects after completion which
    // would otherwise clobber a previously-seen `completed` event and cause
    // the overall result to be considered a failure despite exitCode 0.
    for await (const line of stdoutIterator) {
      try {
        const event = JSON.parse(line) as AddProgressEvent;
        // Always yield the event for UI updates
        yield event;
        // Only update lastEvent when a phase is present and non-empty so we
        // retain the most recent meaningful phase (e.g. 'completed' or
        // 'failed').
        if (event && typeof event.phase === "string" && event.phase.trim() !== "") {
          lastEvent = event;
        }
      } catch {
        // Ignore lines that aren't valid JSON (e.g., error messages)
      }
    }

    // Wait for subprocess to complete
    const { exitCode, stderr } = await exitPromise;

    if (exitCode !== 0) {
      const result: AddResult = {
        success: false,
        url,
        error: stderr.trim() || `CLI exited with code ${exitCode}`,
        exitCode,
        stderr,
      };
      return result;
    }

    const rawId = (lastEvent as { id?: unknown } | null)?.id;
    const eventId =
      typeof rawId === "number"
        ? rawId
        : typeof rawId === "string" && /^\d+$/.test(rawId)
          ? parseInt(rawId, 10)
          : undefined;

    // Determine result from last event
    if (lastEvent?.phase === "completed") {
      const result: AddResult = {
        success: true,
        url,
        title: lastEvent.title,
        id: eventId,
        timestamp: lastEvent.timestamp,
        exitCode,
        stderr,
      };
      return result;
    } else if (lastEvent?.phase === "failed") {
      const result: AddResult = {
        success: false,
        url,
        error: lastEvent.message || "Unknown error during ingestion",
        id: eventId,
        timestamp: lastEvent.timestamp,
        exitCode,
        stderr,
      };
      return result;
    }

    // No events received - check stderr
    const result: AddResult = {
      success: false,
      url,
      error: stderr.trim() || "No progress events received",
      exitCode,
      stderr,
    };
    return result;
  } catch (error) {
    // If the subprocess failed to spawn (ENOENT, EACCES, etc.) we want
    // callers to be able to detect the structured CliRunnerError. Re-throw
    // CliRunnerError so higher-level handlers (for example the Discord
    // message handler) can surface a friendly message to users and avoid
    // leaking stack traces.
    if (error instanceof CliRunnerError) {
      throw error;
    }
    throw error;
  }
}

/**
 * Run the `sb queue` command
 *
 * @param url - URL to queue
 * @param options - Context and runner options
 * @returns Promise that resolves with the queue result
 * @example
 * ```typescript
 * const result = await runQueueCommand("https://example.com", {
 *   channelId: "123",
 *   messageId: "456",
 *   authorId: "789"
 * });
 *
 * if (result.success) {
 *   console.log(`Queued with ID: ${result.id}`);
 * }
 * ```
 */
export async function runQueueCommand(
  url: string,
  options: RunnerOptions = {}
): Promise<QueueResult> {
  // Ensure URL is normalized before queueing to keep behaviour consistent
  try {
    url = normalizeUrl(url);
  } catch {
    // Defensive: if normalization fails, fall back to the raw URL
  }
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "queue",
    [url],
    options
  );

  let queuedLine: string | null = null;

  // Collect stdout lines
  for await (const line of stdoutIterator) {
    if (line.startsWith("Queued:")) {
      queuedLine = line;
    }
  }

  const { exitCode, stderr } = await exitPromise;

  if (exitCode !== 0) {
    return {
      success: false,
      url,
      error: stderr.trim() || `CLI exited with code ${exitCode}`,
    };
  }

  // Parse the queued line for ID
  const idMatch = queuedLine?.match(/\(ID:\s*(\d+)\)/);
  const id = idMatch ? parseInt(idMatch[1], 10) : undefined;

  return {
    success: true,
    url,
    id,
  };
}

/**
 * Run the `ob summary` command
 *
 * @param url - URL to summarize
 * @param options - Context and runner options
 * @returns Promise that resolves with summary result
 */
export async function runSummaryCommand(
  url: string,
  options: RunnerOptions = {}
): Promise<SummaryResult> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "summary",
    [url],
    options
  );

  const stdoutLines: string[] = [];
  for await (const line of stdoutIterator) {
    stdoutLines.push(line);
  }

  const { exitCode, stderr } = await exitPromise;

  if (exitCode !== 0) {
    return {
      success: false,
      url,
      error: stderr.trim() || `CLI exited with code ${exitCode}`,
    };
  }

  const summary = stdoutLines.join("\n").trim();
  if (!summary) {
    return {
      success: false,
      url,
      error: "No summary output received",
    };
  }

  return {
    success: true,
    url,
    summary,
  };
}

/**
 * Run the `sb stats` command
 *
 * @param options - Runner options
 * @returns Promise that resolves with database statistics
 * @example
 * ```typescript
 * const stats = await runStatsCommand();
 * console.log(`Total links: ${stats.totalLinks}`);
 * ```
 */
export async function runStatsCommand(
  options: RunnerOptions = {}
): Promise<{ raw: string }> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "stats",
    [],
    options
  );

  const stdoutLines: string[] = [];
  for await (const line of stdoutIterator) {
    stdoutLines.push(line);
  }

  const { exitCode, stderr } = await exitPromise;

  if (exitCode !== 0) {
    throw new CliRunnerError(
      `Stats command failed: ${stderr.trim() || `exit code ${exitCode}`}`,
      exitCode,
      stderr
    );
  }

  return { raw: stdoutLines.join("\n") };
}

/**
 * Run a generic CLI command
 *
 * Low-level function for running any CLI command with full control.
 *
 * @param command - The CLI command to run
 * @param args - Arguments for the command
 * @param options - Options for the subprocess
 * @returns Object with stdout lines array, stderr, and exit code
 * @example
 * ```typescript
 * const result = await runCliCommand("search", ["--limit", "5", "query"]);
 * console.log(result.stdout);
 * ```
 */
export async function runCliCommand(
  command: string,
  args: string[],
  options: RunnerOptions = {}
): Promise<CliCommandResult> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    command,
    args,
    options
  );

  const stdout: string[] = [];
  for await (const line of stdoutIterator) {
    stdout.push(line);
  }

  const { exitCode, stderr } = await exitPromise;

  return {
    stdout,
    stderr,
    exitCode,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if the CLI is available and working
 *
 * @returns Promise that resolves to true if CLI is available
 */
export async function isCliAvailable(): Promise<boolean> {
  try {
    const { exitCode } = await runCliCommand("--version", [], {
      timeoutMs: 5000,
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Set the path to the ob CLI binary at runtime. Passing `undefined` will reset
 * the value to the environment variable OB_CLI_PATH or the default "ob".
 *
 * This is useful for tests that need to override which executable is spawned.
 *
 * @param path - Path to the ob binary or undefined to reset
 */
export function setCliPath(path: string | undefined): void {
  const prev = cliExecutable;
  cliExecutable = path || process.env.OB_CLI_PATH || "ob";
  console.warn(`setCliPath: changed cli executable from ${prev} to ${cliExecutable}`);
}

/**
 * Get the currently configured CLI executable path (useful for tests)
 */
export function getCliPath(): string {
  return cliExecutable;
}
