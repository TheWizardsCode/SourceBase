/**
 * LifecycleManager interface for bot startup and shutdown management
 * 
 * This interface abstracts the lifecycle management of the Discord bot,
 * including startup initialization, recovery from restarts, graceful shutdown,
 * and status restoration.
 * 
 * @module lifecycle-manager
 * @example
 * ```typescript
 * // Implementation example
 * class BotLifecycleManager implements LifecycleManager {
 *   private isShuttingDown = false;
 *   
 *   constructor(
 *     private readonly bot: DiscordBot,
 *     private readonly documentQueue: DocumentQueue,
 *     private readonly repository: LinkRepository,
 *     private readonly logger: Logger
 *   ) {}
 *   
 *   async startup(): Promise<void> {
 *     this.logger.info("Starting bot lifecycle");
 *     
 *     // Initialize queue and restore pending items
 *     const pendingItems = await this.documentQueue.initialize();
 *     
 *     // Start Discord connection
 *     await this.bot.start();
 *     
 *     // Perform startup recovery for missed messages
 *     await this.performStartupRecovery();
 *     
 *     // Restore status messages for pending items
 *     if (pendingItems.length > 0) {
 *       await this.restoreStatusMessages(pendingItems);
 *     }
 *     
 *     // Send startup notifications
 *     await this.sendStartupNotifications();
 *     
 *     this.logger.info("Bot lifecycle startup complete");
 *   }
 *   
 *   async shutdown(signal: ShutdownSignal): Promise<void> {
 *     if (this.isShuttingDown) {
 *       this.logger.info("Forced shutdown");
 *       process.exit(1);
 *     }
 *     
 *     this.isShuttingDown = true;
 *     this.logger.info(`Starting graceful shutdown (${signal})`);
 *     
 *     try {
 *       // Send maintenance notifications
 *       await this.sendMaintenanceNotifications();
 *       
 *       // Stop queue processing
 *       this.documentQueue.stopPolling();
 *       
 *       // Requeue current item if any
 *       const currentItem = this.documentQueue.getCurrentItem();
 *       if (currentItem) {
 *         this.documentQueue.requeueCurrentItem();
 *       }
 *       
 *       // Close database connection
 *       await closeDbPool();
 *       
 *       this.logger.info("Graceful shutdown complete");
 *       process.exit(0);
 *     } catch (error) {
 *       this.logger.error("Shutdown failed", { error });
 *       process.exit(1);
 *     }
 *   }
 * }
 * ```
 */

import type { Message, TextChannel, Client } from "discord.js";
import type { 
  ShutdownSignal, 
  ShutdownOptions, 
  RecoveryResult, 
  PendingQueueItem, 
  Logger,
  Result 
} from "./types.js";

/**
 * Configuration options for lifecycle manager
 */
export interface LifecycleManagerOptions {
  /** Discord bot client */
  bot: {
    start(): Promise<void>;
    getClient(): Client;
  };
  /** Document processing queue */
  documentQueue: {
    initialize(): Promise<PendingQueueItem[]>;
    stopPolling(): void;
    getCurrentItem(): { url: string } | null;
    requeueCurrentItem(): void;
  };
  /** Repository for persistence */
  repository: {
    getCheckpoint(channelId: string): Promise<string | null>;
    saveCheckpoint(channelId: string, messageId: string): Promise<void>;
  };
  /** Logger instance */
  logger: Logger;
  /** Channel ID for recovery operations */
  channelId: string;
  /** Maximum messages to recover on startup */
  maxRecoveryMessages?: number;
  /** Enable startup recovery */
  enableRecovery?: boolean;
}

/**
 * Result of lifecycle operation
 */
export interface LifecycleResult extends Result<void> {
  /** Time taken for the operation in milliseconds */
  durationMs?: number;
  /** Additional metadata about the operation */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for bot lifecycle management
 * 
 * Implementations handle the complete lifecycle of the bot from startup
 * through shutdown, including:
 * - Initialization and service startup
 * - Recovery from restarts
 * - Status message restoration
 * - Graceful shutdown with cleanup
 * 
 * This abstraction allows for:
 * - Testing lifecycle logic without Discord API
 * - Custom lifecycle strategies (e.g., cluster mode)
 * - Consistent error handling and cleanup
 * 
 * @example
 * ```typescript
 * // Usage in main bot file
 * const lifecycleManager = createLifecycleManager({
 *   bot,
 *   documentQueue,
 *   repository,
 *   logger,
 *   channelId: config.DISCORD_CHANNEL_ID,
 *   maxRecoveryMessages: 100
 * });
 * 
 * // Register shutdown handlers
 * process.on("SIGTERM", () => lifecycleManager.shutdown("SIGTERM"));
 * process.on("SIGINT", () => lifecycleManager.shutdown("SIGINT"));
 * 
 * // Start the bot
 * await lifecycleManager.startup();
 * ```
 */
export interface LifecycleManager {
  /**
   * Perform bot startup sequence
   * 
   * Executes the complete startup sequence:
   * 1. Initialize queue and restore pending items
   * 2. Start Discord bot connection
   * 3. Perform startup recovery (if enabled)
   * 4. Restore status messages for pending items
   * 5. Send startup notifications
   * 
   * @returns Promise resolving when startup is complete
   * @throws Should catch errors, log them, and exit process on fatal errors
   * 
   * @example
   * ```typescript
   * try {
   *   await lifecycleManager.startup();
   *   logger.info("Bot started successfully");
   * } catch (error) {
   *   logger.error("Startup failed", { error });
   *   process.exit(1);
   * }
   * ```
   */
  startup(): Promise<void>;

  /**
   * Perform graceful shutdown sequence
   * 
   * Executes the complete shutdown sequence:
   * 1. Check for duplicate shutdown signals
   * 2. Send maintenance notifications to channels
   * 3. Clean up progress and queue status messages
   * 4. Stop queue polling
   * 5. Requeue current processing item
   * 6. Close database connection
   * 7. Exit process
   * 
   * @param signal - The shutdown signal that triggered this
   * @param options - Optional shutdown configuration
   * @returns Promise resolving when shutdown is complete (typically never returns as process exits)
   * @throws Should catch errors and force exit
   * 
   * @example
   * ```typescript
   * process.on("SIGTERM", () => {
   *   lifecycleManager.shutdown("SIGTERM");
   * });
   * 
   * process.on("SIGINT", () => {
   *   lifecycleManager.shutdown("SIGINT");
   * });
   * ```
   */
  shutdown(signal: ShutdownSignal, options?: ShutdownOptions): Promise<void>;

  /**
   * Perform startup recovery to catch up on missed messages
   * 
   * Fetches messages from Discord since the last checkpoint and processes
   * any URLs found. This recovers from bot downtime.
   * 
   * @returns Promise resolving to recovery statistics
   * @throws Should catch errors and log them, not throw
   * 
   * @example
   * ```typescript
   * const result = await lifecycleManager.performStartupRecovery();
   * logger.info("Recovery complete", {
   *   messagesProcessed: result.messagesProcessed,
   *   urlsQueued: result.urlsQueued
   * });
   * ```
   */
  performStartupRecovery(): Promise<RecoveryResult>;

  /**
   * Restore status message tracking after bot restart
   * 
   * Reconnects to status messages for items that were pending when the bot
   * restarted. This allows progress updates to continue for in-flight items.
   * 
   * @param pendingItems - Items loaded from database that need status restoration
   * @returns Promise resolving when restoration is complete
   * @throws Should catch errors and continue with other channels
   * 
   * @example
   * ```typescript
   * const pendingItems = await documentQueue.initialize();
   * if (pendingItems.length > 0) {
   *   await lifecycleManager.restoreStatusMessages(pendingItems);
   * }
   * ```
   */
  restoreStatusMessages(pendingItems: PendingQueueItem[]): Promise<void>;

  /**
   * Send startup notifications to relevant channels
   * 
   * Notifies channels that the bot is back online and processing has resumed.
   * Typically sent to any channel that had active processing before shutdown.
   * 
   * @returns Promise resolving when notifications are sent
   * @throws Should catch errors and log them, not throw
   * 
   * @example
   * ```typescript
   * await lifecycleManager.sendStartupNotifications();
   * ```
   */
  sendStartupNotifications(): Promise<void>;
}

/**
 * Factory for creating lifecycle managers
 * 
 * @param options - Configuration options
 * @returns New LifecycleManager instance
 * 
 * @example
 * ```typescript
 * const lifecycleManager = createLifecycleManager({
 *   bot,
 *   documentQueue,
 *   repository,
 *   logger,
 *   channelId: config.DISCORD_CHANNEL_ID,
 *   maxRecoveryMessages: 100,
 *   enableRecovery: true
 * });
 * ```
 */
export type LifecycleManagerFactory = (options: LifecycleManagerOptions) => LifecycleManager;

/**
 * Extended lifecycle manager with health check capabilities
 * Useful for container orchestration and monitoring
 * 
 * @example
 * ```typescript
 * class HealthAwareLifecycleManager implements LifecycleManager, HealthCheckable {
 *   private lastHealthCheck = Date.now();
 *   
 *   async healthCheck(): Promise<HealthStatus> {
 *     const checks = await Promise.all([
 *       this.checkDiscordConnection(),
 *       this.checkDatabaseConnection(),
 *       this.checkQueueHealth()
 *     ]);
 *     
 *     const healthy = checks.every(c => c.healthy);
 *     this.lastHealthCheck = Date.now();
 *     
 *     return {
 *       healthy,
 *       checks: checks.reduce((acc, c) => ({ ...acc, [c.name]: c }), {}),
 *       timestamp: new Date().toISOString()
 *     };
 *   }
 * }
 * ```
 */
export interface HealthCheckable {
  /**
   * Perform health check
   * @returns Promise resolving to health status
   */
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Health status result
 */
export interface HealthStatus {
  /** Whether the system is healthy */
  healthy: boolean;
  /** Individual check results */
  checks: Record<string, HealthCheckResult>;
  /** ISO timestamp of the check */
  timestamp: string;
}

/**
 * Individual health check result
 */
export interface HealthCheckResult {
  /** Whether this check passed */
  healthy: boolean;
  /** Check name */
  name: string;
  /** Optional message */
  message?: string;
  /** Response time in milliseconds */
  responseTimeMs?: number;
}
