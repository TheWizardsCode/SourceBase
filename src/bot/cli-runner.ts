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
  child.on("exit", () => {
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

// ============================================================================
// Configuration
// ============================================================================

/** Path to the sb CLI binary */
const SB_CLI_PATH = process.env.SB_CLI_PATH || "sb";

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

  // Build command arguments
  const cmdArgs = [command];

  // Add context flags if provided
  if (channelId) {
    cmdArgs.push("--channel-id", channelId);
  }
  if (messageId) {
    cmdArgs.push("--message-id", messageId);
  }
  if (authorId) {
    cmdArgs.push("--author-id", authorId);
  }

  // Add remaining args
  cmdArgs.push(...args);

  // Debug: Log environment variables being passed to CLI
  const hasDbUrl = !!process.env.DATABASE_URL;
  console.log(`[CLI Debug] Spawning CLI with DATABASE_URL ${hasDbUrl ? 'set' : 'NOT SET'}`);
  console.log(`[CLI Debug] Command: ${SB_CLI_PATH} ${cmdArgs.join(' ')}`);
  
  // Spawn the subprocess
  const subprocess = spawn(SB_CLI_PATH, cmdArgs, {
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
    stderrBuffer += data.toString();
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

    subprocess.on("error", (error: Error) => {
      clearTimeout(timeout);
      reject(
        new CliRunnerError(
          `Failed to spawn CLI: ${error.message}`,
          -1,
          stderrBuffer
        )
      );
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
    // Yield progress events as they arrive
    for await (const line of stdoutIterator) {
      try {
        const event = JSON.parse(line) as AddProgressEvent;
        lastEvent = event;
        yield event;
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
      };
      return result;
    }

    // Determine result from last event
    if (lastEvent?.phase === "completed") {
      const result: AddResult = {
        success: true,
        url,
        title: lastEvent.title,
      };
      return result;
    } else if (lastEvent?.phase === "failed") {
      const result: AddResult = {
        success: false,
        url,
        error: lastEvent.message || "Unknown error during ingestion",
      };
      return result;
    }

    // No events received - check stderr
    const result: AddResult = {
      success: false,
      url,
      error: stderr.trim() || "No progress events received",
    };
    return result;
  } catch (error) {
    if (error instanceof CliRunnerError) {
      const result: AddResult = {
        success: false,
        url,
        error: error.message,
      };
      return result;
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
): Promise<StatsResult> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "stats",
    ["--format", "json"],
    options
  );

  let jsonOutput = "";

  // Collect stdout
  for await (const line of stdoutIterator) {
    jsonOutput += line;
  }

  const { exitCode, stderr } = await exitPromise;

  if (exitCode !== 0) {
    throw new CliRunnerError(
      `Stats command failed: ${stderr.trim() || `exit code ${exitCode}`}`,
      exitCode,
      stderr
    );
  }

  try {
    const stats = JSON.parse(jsonOutput) as StatsResult;
    return stats;
  } catch {
    throw new CliRunnerError(
      "Failed to parse stats JSON output",
      exitCode,
      stderr
    );
  }
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
 * Set the path to the sb CLI binary
 *
 * @param path - Path to the sb binary
 */
export function setCliPath(path: string): void {
  // This would need to be implemented via module-level variable
  // For now, use the SB_CLI_PATH environment variable
  process.env.SB_CLI_PATH = path;
}
