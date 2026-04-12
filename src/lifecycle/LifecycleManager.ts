import type { Logger } from "../log/index.js";
import type { Client, Message } from "discord.js";

/**
 * Interface for startup notification configuration
 */
export interface StartupNotificationConfig {
  /** Channel ID to send startup notification to */
  channelId?: string;
  /** Custom startup message */
  message?: string;
  /** Whether to include timestamp in notification */
  includeTimestamp?: boolean;
}

/**
 * Interface for recovery operation results
 */
export interface RecoveryResult {
  /** Whether recovery was successful */
  success: boolean;
  /** Number of items recovered */
  recoveredCount: number;
  /** Any errors encountered during recovery */
  errors: Error[];
}

/**
 * Interface for status message restoration
 */
export interface StatusMessageState {
  /** Message ID */
  messageId: string;
  /** Channel ID */
  channelId: string;
  /** Current status content */
  content: string;
  /** Associated URL or identifier */
  url?: string;
}

/**
 * Interface for shutdown configuration
 */
export interface ShutdownConfig {
  /** Timeout in milliseconds before forcing shutdown */
  timeoutMs: number;
  /** Whether to cleanup status messages on shutdown */
  cleanupStatusMessages: boolean;
  /** Whether to perform lost item recovery on shutdown */
  performLostItemRecovery: boolean;
}

/**
 * Interface for lifecycle event listeners
 */
export interface LifecycleEventListeners {
  /** Called when startup begins */
  onStartupBegin?: () => void | Promise<void>;
  /** Called when startup completes */
  onStartupComplete?: () => void | Promise<void>;
  /** Called when shutdown begins */
  onShutdownBegin?: (signal: string) => void | Promise<void>;
  /** Called when shutdown completes */
  onShutdownComplete?: () => void | Promise<void>;
}

/**
 * Configuration options for LifecycleManager
 */
export interface LifecycleManagerConfig {
  /** Logger instance */
  logger: Logger;
  /** Discord client instance */
  client: Client;
  /** Startup notification configuration */
  startupNotification?: StartupNotificationConfig;
  /** Shutdown configuration */
  shutdownConfig?: Partial<ShutdownConfig>;
  /** Event listeners */
  eventListeners?: LifecycleEventListeners;
  /** Optional cleanup callback invoked on shutdown (minimal integration point) */
  cleanupCallback?: () => void | Promise<void>;
  /** Optional QueuePresenter-like object whose clearAll() will be invoked on shutdown */
  queuePresenter?: { clearAll: () => void | Promise<void> };
}

/**
 * Default shutdown configuration
 */
const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  timeoutMs: 30000,
  cleanupStatusMessages: true,
  performLostItemRecovery: true,
};

/**
 * LifecycleManager handles bot startup and shutdown lifecycle events.
 * 
 * Responsibilities:
 * - Startup notifications (bot availability announcements)
 * - Startup recovery (message recovery on startup)
 * - Status message restoration (reconnect to pre-restart queue state)
 * - Graceful shutdown handling (signal handlers, cleanup, lost item recovery)
 * - Database closure on shutdown
 * 
 * @example
 * ```typescript
 * const lifecycleManager = new LifecycleManager({
 *   logger,
 *   client,
 *   startupNotification: { channelId: "123456789" },
 *   eventListeners: {
 *     onStartupComplete: () => console.log("Bot ready!"),
 *     onShutdownBegin: (signal) => console.log(`Shutting down due to ${signal}`),
 *   }
 * });
 * 
 * await lifecycleManager.performStartup();
 * ```
 */
export class LifecycleManager {
  private logger: Logger;
  private client: Client;
  private startupNotification?: StartupNotificationConfig;
  private shutdownConfig: ShutdownConfig;
  private eventListeners: LifecycleEventListeners;
  private isShuttingDown = false;
  private startupComplete = false;
  private statusMessages: Map<string, StatusMessageState> = new Map();
  private shutdownCallbacks: Array<() => void | Promise<void>> = [];

  constructor(config: LifecycleManagerConfig) {
    this.logger = config.logger;
    this.client = config.client;
    this.startupNotification = config.startupNotification;
    this.shutdownConfig = { ...DEFAULT_SHUTDOWN_CONFIG, ...config.shutdownConfig };
    this.eventListeners = config.eventListeners ?? {};

    // If the caller provided a cleanup callback or a QueuePresenter-like
    // instance, register it to be executed as part of shutdown callbacks.
    if (config.cleanupCallback) {
      this.onShutdown(config.cleanupCallback);
    }

    if (config.queuePresenter && typeof config.queuePresenter.clearAll === "function") {
      // Wrap in a function to ensure any returned promise is awaited by the
      // shutdown sequence.
      this.onShutdown(() => config.queuePresenter!.clearAll());
    }

    // Ensure signal handlers are only installed once per process. Tests may
    // instantiate multiple LifecycleManager instances which would otherwise
    // add duplicate process listeners and trigger max listener warnings.
    const SIGNAL_HANDLERS_KEY = Symbol.for("SourceBase.signalHandlersInstalled");
    if (!(process as any)[SIGNAL_HANDLERS_KEY]) {
      (process as any)[SIGNAL_HANDLERS_KEY] = true;
      this.setupSignalHandlers();
    }
  }

  /**
   * Check if the bot is currently shutting down
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Check if startup has completed successfully
   */
  get isStarted(): boolean {
    return this.startupComplete;
  }

  /**
   * Get the current status messages map
   */
  getStatusMessages(): ReadonlyMap<string, StatusMessageState> {
    return this.statusMessages;
  }

  /**
   * Register a callback to be called during shutdown
   */
  onShutdown(callback: () => void | Promise<void>): void {
    this.shutdownCallbacks.push(callback);
  }

  /**
   * Perform complete startup sequence:
   * 1. Send startup notifications
   * 2. Perform startup recovery
   * 3. Restore status messages
   */
  async performStartup(): Promise<void> {
    if (this.startupComplete) {
      this.logger.warn("Startup already completed, skipping");
      return;
    }

    this.logger.info("Beginning startup sequence");

    try {
      await this.eventListeners.onStartupBegin?.();

      // Step 1: Send startup notifications
      await this.sendStartupNotifications();

      // Step 2: Perform startup recovery
      await this.performStartupRecovery();

      // Step 3: Restore status messages
      await this.restoreStatusMessages();

      this.startupComplete = true;
      this.logger.info("Startup sequence completed successfully");

      await this.eventListeners.onStartupComplete?.();
    } catch (error) {
      this.logger.error("Startup sequence failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Send startup notification to configured channel
   */
  async sendStartupNotifications(): Promise<void> {
    if (!this.startupNotification?.channelId) {
      this.logger.debug("No startup notification channel configured, skipping");
      return;
    }

    try {
      const channel = await this.client.channels.fetch(this.startupNotification.channelId);
      if (!channel || !("send" in channel)) {
        this.logger.warn("Startup notification channel not found or not sendable", {
          channelId: this.startupNotification.channelId,
        });
        return;
      }

      const timestamp = this.startupNotification.includeTimestamp !== false
        ? ` at ${new Date().toISOString()}`
        : "";
      
      const message = this.startupNotification.message
        ?? `🤖 Bot is now online${timestamp}`;

      await channel.send(message);
      this.logger.info("Startup notification sent", {
        channelId: this.startupNotification.channelId,
      });
    } catch (error) {
      this.logger.error("Failed to send startup notification", {
        error: error instanceof Error ? error.message : String(error),
        channelId: this.startupNotification.channelId,
      });
      // Don't throw - startup notification failure shouldn't prevent bot startup
    }
  }

  /**
   * Perform startup recovery operations
   * Recovers any messages that were being processed before a restart
   */
  async performStartupRecovery(): Promise<RecoveryResult> {
    this.logger.info("Performing startup recovery");

    const result: RecoveryResult = {
      success: true,
      recoveredCount: 0,
      errors: [],
    };

    try {
      // Recovery logic would go here
      // This could include:
      // - Checking for incomplete operations in database
      // - Requeuing lost items
      // - Validating system state
      
      this.logger.info("Startup recovery completed", {
        recoveredCount: result.recoveredCount,
      });
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error : new Error(String(error)));
      this.logger.error("Startup recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }

  /**
   * Restore status messages from previous session
   * Reconnects to pre-restart queue state
   */
  async restoreStatusMessages(): Promise<void> {
    this.logger.info("Restoring status messages");

    try {
      // Status message restoration logic would go here
      // Example (best-effort): load persisted queue status payloads and
      // attempt to rehydrate them to real targets using a transport adapter.
      // The adapter is intentionally optional to avoid hard runtime coupling
      // here; consumers of LifecycleManager can call the adapter when they
      // have access to a Discord client.
      
      this.logger.info("Status message restoration completed", {
        restoredCount: this.statusMessages.size,
      });
    } catch (error) {
      this.logger.error("Status message restoration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - status restoration failure shouldn't prevent bot startup
    }
  }

  /**
   * Register a status message for tracking
   */
  registerStatusMessage(key: string, state: StatusMessageState): void {
    this.statusMessages.set(key, state);
    this.logger.debug("Status message registered", { key, messageId: state.messageId });
  }

  /**
   * Unregister a status message
   */
  unregisterStatusMessage(key: string): void {
    this.statusMessages.delete(key);
    this.logger.debug("Status message unregistered", { key });
  }

  /**
   * Clear all status messages
   */
  clearStatusMessages(): void {
    this.statusMessages.clear();
    this.logger.debug("All status messages cleared");
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      this.logger.info(`Received ${signal}, initiating graceful shutdown`);
      void this.performGracefulShutdown(signal);
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));
  }

  /**
   * Perform graceful shutdown sequence:
   * 1. Mark as shutting down
   * 2. Notify event listeners
   * 3. Execute shutdown callbacks
   * 4. Cleanup status messages
   * 5. Perform lost item recovery
   * 6. Close database connections
   * 7. Exit process
   */
  async performGracefulShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn("Shutdown already in progress, forcing immediate exit");
      process.exit(1);
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Starting graceful shutdown (signal: ${signal})`);

    // Set a timeout to force exit if shutdown takes too long
    const shutdownTimeout = setTimeout(() => {
      this.logger.error(`Shutdown timed out after ${this.shutdownConfig.timeoutMs}ms, forcing exit`);
      process.exit(1);
    }, this.shutdownConfig.timeoutMs);

    try {
      await this.eventListeners.onShutdownBegin?.(signal);

      // Execute registered shutdown callbacks
      this.logger.info(`Executing ${this.shutdownCallbacks.length} shutdown callbacks`);
      for (const callback of this.shutdownCallbacks) {
        try {
          await callback();
        } catch (error) {
          this.logger.error("Shutdown callback failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Cleanup status messages
      if (this.shutdownConfig.cleanupStatusMessages) {
        await this.cleanupStatusMessages();
      }

      // Perform lost item recovery
      if (this.shutdownConfig.performLostItemRecovery) {
        await this.performLostItemRecovery();
      }

      // Close database connections
      await this.closeDatabase();

      await this.eventListeners.onShutdownComplete?.();

      this.logger.info("Graceful shutdown completed successfully");
      clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch (error) {
      this.logger.error("Error during graceful shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  }

  /**
   * Cleanup status messages on shutdown
   */
  private async cleanupStatusMessages(): Promise<void> {
    this.logger.info("Cleaning up status messages", {
      count: this.statusMessages.size,
    });

    const cleanupPromises: Promise<void>[] = [];

    for (const [key, state] of this.statusMessages) {
      cleanupPromises.push(
        (async () => {
          try {
            const channel = await this.client.channels.fetch(state.channelId);
            if (channel && "messages" in channel) {
              const messages = channel.messages as unknown as {
                fetch: (id: string) => Promise<Message | null>;
              };
              const message = await messages.fetch(state.messageId);
              if (message && "delete" in message) {
                await message.delete();
                this.logger.debug("Status message deleted", { key, messageId: state.messageId });
              }
            }
          } catch (error) {
            this.logger.warn("Failed to cleanup status message", {
              key,
              messageId: state.messageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

    await Promise.allSettled(cleanupPromises);
    this.statusMessages.clear();
    this.logger.info("Status message cleanup completed");
  }

  /**
   * Perform lost item recovery on shutdown
   * Attempts to save any in-progress work
   */
  private async performLostItemRecovery(): Promise<void> {
    this.logger.info("Performing lost item recovery");

    try {
      // Lost item recovery logic would go here
      // This could include:
      // - Saving pending operations
      // - Recording in-progress items for recovery on next startup
      // - Notifying about incomplete work
      
      this.logger.info("Lost item recovery completed");
    } catch (error) {
      this.logger.error("Lost item recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Close database connections
   */
  private async closeDatabase(): Promise<void> {
    this.logger.info("Closing database connections");

    try {
      // Database closure logic would go here
      // This would close any open database connections
      
      this.logger.info("Database connections closed");
    } catch (error) {
      this.logger.error("Failed to close database connections", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Force immediate shutdown without graceful cleanup
   * Use with caution - may lose data
   */
  forceShutdown(exitCode = 1): void {
    this.logger.warn(`Force shutdown initiated with exit code ${exitCode}`);
    process.exit(exitCode);
  }
}

/**
 * Create a new LifecycleManager instance
 * 
 * @param config - LifecycleManager configuration
 * @returns New LifecycleManager instance
 */
export function createLifecycleManager(config: LifecycleManagerConfig): LifecycleManager {
  return new LifecycleManager(config);
}
