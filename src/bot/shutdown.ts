/**
 * Bot Shutdown Handler
 * 
 * This module provides graceful shutdown handling for the bot,
 * including cleanup of active CLI child processes.
 * 
 * @module bot/shutdown
 * @example
 * ```typescript
 * import { setupGracefulShutdown, registerShutdownCallback } from "./shutdown";
 * 
 * // Register a custom cleanup callback
 * registerShutdownCallback(async () => {
 *   await closeDatabaseConnections();
 * });
 * 
 * // Setup graceful shutdown handlers
 * setupGracefulShutdown();
 * ```
 */

import { terminateAllChildProcesses, getActiveChildProcessCount } from "./cli-runner.js";

// ============================================================================
// State
// ============================================================================

/** Whether shutdown is currently in progress */
let isShuttingDown = false;

/** Custom shutdown callbacks */
const shutdownCallbacks: Array<() => Promise<void> | void> = [];

// ============================================================================
// Callback Registration
// ============================================================================

/**
 * Register a callback to be executed during graceful shutdown
 * 
 * @param callback - Function to call during shutdown
 * @example
 * ```typescript
 * registerShutdownCallback(async () => {
 *   await closeDatabaseConnections();
 * });
 * ```
 */
export function registerShutdownCallback(callback: () => Promise<void> | void): void {
  shutdownCallbacks.push(callback);
}

/**
 * Unregister a previously registered shutdown callback
 * 
 * @param callback - The callback to remove
 */
export function unregisterShutdownCallback(callback: () => Promise<void> | void): void {
  const index = shutdownCallbacks.indexOf(callback);
  if (index !== -1) {
    shutdownCallbacks.splice(index, 1);
  }
}

// ============================================================================
// Shutdown Logic
// ============================================================================

/**
 * Check if shutdown is in progress
 * 
 * @returns true if shutdown has been initiated
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Perform graceful shutdown
 * 
 * This function:
 * 1. Kills all active CLI child processes
 * 2. Executes all registered shutdown callbacks
 * 3. Exits the process
 * 
 * @param signal - The signal that triggered shutdown (SIGTERM, SIGINT, etc.)
 * @param exitCode - Exit code to use (default: 0)
 * @param logger - Optional logger for shutdown messages
 * @param exitFn - Optional exit function for testing (defaults to process.exit)
 */
export async function gracefulShutdown(
  signal: string,
  exitCode: number = 0,
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void },
  exitFn: (code: number) => never = process.exit
): Promise<void> {
  if (isShuttingDown) {
    logger?.info("Shutdown already in progress, forcing exit");
    exitFn(1);
  }

  isShuttingDown = true;
  logger?.info(`Received ${signal}, starting graceful shutdown...`);

  try {
    // Step 1: Terminate all active child processes
    const activeCount = getActiveChildProcessCount();
    if (activeCount > 0) {
      logger?.info(`Terminating ${activeCount} active CLI child process(es)...`);
      await terminateAllChildProcesses();
      logger?.info("All CLI child processes terminated");
    }

    // Step 2: Execute all registered shutdown callbacks
    if (shutdownCallbacks.length > 0) {
      logger?.info(`Executing ${shutdownCallbacks.length} shutdown callback(s)...`);
      const callbackPromises = shutdownCallbacks.map(async (callback, index) => {
        try {
          await callback();
        } catch (err) {
          logger?.warn(`Shutdown callback ${index} failed`, {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      });

      // Execute callbacks with a timeout
      await Promise.race([
        Promise.all(callbackPromises),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Shutdown callbacks timeout")), 10000)
        )
      ]).catch(err => {
        logger?.warn("Some shutdown callbacks timed out", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    logger?.info("Graceful shutdown complete");
    exitFn(exitCode);
  } catch (err) {
    logger?.error("Error during graceful shutdown", {
      error: err instanceof Error ? err.message : String(err)
    });
    exitFn(1);
  }
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Setup graceful shutdown handlers for SIGTERM and SIGINT
 * 
 * This should be called once during bot startup.
 * 
 * @param logger - Optional logger for shutdown messages
 * @example
 * ```typescript
 * import { setupGracefulShutdown } from "./shutdown";
 * 
 * setupGracefulShutdown();
 * ```
 */
export function setupGracefulShutdown(
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void }
): void {
  // Handle SIGTERM (e.g., from Docker, Kubernetes)
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM", 0, logger));

  // Handle SIGINT (e.g., Ctrl+C)
  process.on("SIGINT", () => gracefulShutdown("SIGINT", 0, logger));

  // Handle uncaught exceptions
  process.on("uncaughtException", (err) => {
    logger?.error("Uncaught exception, initiating shutdown", {
      error: err.message,
      stack: err.stack
    });
    gracefulShutdown("uncaughtException", 1, logger);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    logger?.error("Unhandled promise rejection, initiating shutdown", {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
    gracefulShutdown("unhandledRejection", 1, logger);
  });
}

/**
 * Remove all graceful shutdown handlers
 * 
 * Useful for testing to avoid handler leaks between tests.
 */
export function removeGracefulShutdownHandlers(): void {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
}

/**
 * Reset internal state for testing
 * 
 * Clears shutdown callbacks and resets the shutting down flag.
 * Only use this in tests.
 */
export function __resetShutdownState(): void {
  isShuttingDown = false;
  shutdownCallbacks.length = 0;
}
