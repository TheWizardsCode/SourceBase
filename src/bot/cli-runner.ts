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

import { spawn } from "child_process";
import { createInterface } from "readline";
import type { CliProgressEvent } from "../cli/presenters/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Context for CLI commands that need Discord message association
 */
export interface CliContext {
  /** Discord channel ID */
  channelId?: string;
  /** Discord message ID */
  messageId?: string;
  /** Discord author ID */
  authorId?: string;
}

/**
 * Options for running CLI commands
 */
export interface CliRunnerOptions extends CliContext {
  /** Working directory for the subprocess */
  cwd?: string;
  /** Environment variables for the subprocess */
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result of a queue command
 */
export interface QueueResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The URL that was queued */
  url: string;
  /** Queue entry ID if successful */
  id?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of an add command (final result after all progress events)
 */
export interface AddResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The URL that was added */
  url: string;
  /** Document title if successful */
  title?: string;
  /** Document ID if successful */
  id?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Database statistics from the stats command
 */
export interface StatsResult {
  /** Total number of links in the database */
  totalLinks: number;
  /** Number of links with embeddings */
  linksWithEmbeddings: number;
  /** Number of links with summaries */
  linksWithSummaries: number;
  /** Number of links with content */
  linksWithContent: number;
  /** Number of links with transcripts */
  linksWithTranscripts: number;
  /** Number of links added in the last 24 hours */
  linksLast24Hours: number;
  /** Number of links added in the last 7 days */
  linksLast7Days: number;
  /** Number of links added in the last 30 days */
  linksLast30Days: number;
}

/**
 * Structured error from CLI subprocess
 */
export class CliRunnerError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
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
  options: CliRunnerOptions = {}
): {
  subprocess: ReturnType<typeof spawn>;
  stdoutIterator: AsyncIterableIterator<string>;
  exitPromise: Promise<{ exitCode: number; stderr: string }>;
} {
  const { channelId, messageId, authorId, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  
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
  
  // Spawn the subprocess
  const subprocess = spawn(SB_CLI_PATH, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  
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
  const exitPromise = new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subprocess.kill("SIGTERM");
      reject(new CliRunnerError(
        `CLI command timed out after ${timeoutMs}ms`,
        -1,
        stderrBuffer
      ));
    }, timeoutMs);
    
    subprocess.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 0,
        stderr: stderrBuffer,
      });
    });
    
    subprocess.on("error", (error) => {
      clearTimeout(timeout);
      reject(new CliRunnerError(
        `Failed to spawn CLI: ${error.message}`,
        -1,
        stderrBuffer
      ));
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
 * const result = await runAddCommand("https://example.com", {
 *   channelId: "123",
 *   messageId: "456",
 *   authorId: "789"
 * });
 * 
 * for await (const event of result) {
 *   console.log(`${event.phase}: ${event.url}`);
 * }
 * 
 * // Get final result
 * const finalResult = await result.return?.();
 * ```
 */
export async function* runAddCommand(
  url: string,
  options: CliRunnerOptions = {}
): AsyncGenerator<CliProgressEvent, AddResult, unknown> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(
    "add",
    ["--format", "ndjson", url],
    options
  );
  
  let lastEvent: CliProgressEvent | null = null;
  
  try {
    // Yield progress events as they arrive
    for await (const line of stdoutIterator) {
      try {
        const event = JSON.parse(line) as CliProgressEvent;
        lastEvent = event;
        yield event;
      } catch {
        // Ignore lines that aren't valid JSON (e.g., error messages)
      }
    }
    
    // Wait for subprocess to complete
    const { exitCode, stderr } = await exitPromise;
    
    if (exitCode !== 0) {
      return {
        success: false,
        url,
        error: stderr.trim() || `CLI exited with code ${exitCode}`,
      };
    }
    
    // Determine result from last event
    if (lastEvent?.phase === "completed") {
      return {
        success: true,
        url,
        title: lastEvent.title,
      };
    } else if (lastEvent?.phase === "failed") {
      return {
        success: false,
        url,
        error: lastEvent.message || "Unknown error during ingestion",
      };
    }
    
    // No events received - check stderr
    return {
      success: false,
      url,
      error: stderr.trim() || "No progress events received",
    };
  } catch (error) {
    if (error instanceof CliRunnerError) {
      return {
        success: false,
        url,
        error: error.message,
      };
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
  options: CliRunnerOptions = {}
): Promise<QueueResult> {
  const { stdoutIterator, exitPromise } = runCliSubprocess("queue", [url], options);
  
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
  options: Omit<CliRunnerOptions, keyof CliContext> = {}
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
  options: CliRunnerOptions = {}
): Promise<{
  stdout: string[];
  stderr: string;
  exitCode: number;
}> {
  const { stdoutIterator, exitPromise } = runCliSubprocess(command, args, options);
  
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
    const { exitCode } = await runCliCommand("--version", [], { timeoutMs: 5000 });
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
