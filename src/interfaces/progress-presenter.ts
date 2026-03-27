/**
 * ProgressPresenter interface for formatting and managing progress messages
 * 
 * This interface abstracts the presentation logic for ingestion progress updates,
 * allowing the core ingestion logic to remain independent of Discord-specific
 * message formatting and lifecycle management.
 * 
 * Discord-specific options are added on top of the CLI base interfaces.
 * 
 * @module progress-presenter
 * @example
 * ```typescript
 * // Discord implementation
 * class DiscordProgressPresenter extends ProgressPresenterBase {
 *   private statusMessage?: Message;
 *   
 *   constructor(
 *     private readonly channel: TextChannel,
 *     private readonly logger: Logger
 *   ) {
 *     super({ logger, maxMessageLength: 2000 });
 *   }
 *   
 *   async update(content: string): Promise<void> {
 *     if (!this.statusMessage) {
 *       this.statusMessage = await this.channel.send(content);
 *     } else if (this.statusMessage.content !== content) {
 *       await this.statusMessage.edit(content);
 *     }
 *   }
 *   
 *   async clear(): Promise<void> {
 *     if (this.statusMessage) {
 *       await this.statusMessage.delete();
 *       this.statusMessage = undefined;
 *     }
 *   }
 * }
 * ```
 */

import type { Message, TextChannel } from "discord.js";
import type { ProgressUpdate, IngestionProgress, Logger } from "./cli-types.js";
import { 
  CliProgressPresenterBase, 
  PHASE_EMOJI, 
  PHASE_LABEL,
  type CliProgressPresenterOptions,
  type CliPresenterResult
} from "./cli-progress-presenter.js";

/**
 * Configuration options for Discord progress presenters
 * Extends CLI base options with Discord-specific fields
 */
export interface ProgressPresenterOptions extends CliProgressPresenterOptions {
  /** Discord channel for sending messages */
  channel: TextChannel;
}

/**
 * Result of a presenter operation (Discord-specific)
 * Extends CLI base result with Discord message reference
 */
export interface PresenterResult extends CliPresenterResult {
  /** The message that was created or updated (if applicable) */
  message?: Message;
}

/**
 * Interface for progress message presenters (Discord version)
 * 
 * Implementations handle the formatting, display, and cleanup of progress
 * messages during document ingestion in Discord channels.
 * 
 * @example
 * ```typescript
 * // Usage in ingestion service
 * class IngestionService {
 *   constructor(private readonly presenter: ProgressPresenter) {}
 *   
 *   async processUrl(url: string): Promise<void> {
 *     // Update progress
 *     await this.presenter.update(
 *       this.presenter.format(
 *         { phase: "downloading", url, current: 1, total: 1 },
 *         { urls: [url], completed: 0, failed: 0, currentUrl: url, phase: "downloading" }
 *       )
 *     );
 *     
 *     // ... process ...
 *     
 *     // Clear when done
 *     await this.presenter.clear();
 *   }
 * }
 * ```
 */
export interface ProgressPresenter {
  /**
   * Format a progress update into a display string
   * 
   * @param update - The individual progress update
   * @param overall - The overall batch progress state
   * @returns Formatted message string ready for display
   */
  format(update: ProgressUpdate, overall: IngestionProgress): string;

  /**
   * Update or create the progress message
   * 
   * Creates a new message on first call, updates existing message on subsequent calls.
   * Implementations should handle rate limiting and message content validation.
   * 
   * @param content - The formatted progress message content
   * @returns Promise resolving when the update is complete
   * @throws Should catch Discord API errors and log them, not throw
   */
  update(content: string): Promise<void>;

  /**
   * Clear/remove the progress message
   * 
   * Deletes the progress message from Discord. Should be called when:
   * - Processing completes successfully
   * - Processing fails
   * - A final summary message will replace the progress message
   * 
   * @returns Promise resolving when cleanup is complete
   * @throws Should catch Discord API errors (message already deleted) and ignore them
   */
  clear(): Promise<void>;

  /**
   * Send a final completion message
   * 
   * Sends a new message (does not update the progress message) showing
   * the final result. The progress message should be cleared first.
   * 
   * @param update - The final progress update (phase should be "completed" or "failed")
   * @param overall - The overall batch progress
   * @returns Promise resolving when the message is sent
   */
  sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void>;
}

/**
 * Factory for creating progress presenters
 * 
 * @param options - Configuration options
 * @returns New ProgressPresenter instance
 * 
 * @example
 * ```typescript
 * const presenter = createProgressPresenter({
 *   channel: textChannel,
 *   logger,
 *   maxMessageLength: 2000
 * });
 * ```
 */
export type ProgressPresenterFactory = (options: ProgressPresenterOptions) => ProgressPresenter;

// Re-export CLI base constants and types for convenience
export { PHASE_EMOJI, PHASE_LABEL };
export type { CliProgressPresenterOptions, CliPresenterResult };

/**
 * Base class with common formatting utilities
 * 
 * Extend this class to create custom progress presenters with
 * consistent formatting behavior.
 * 
 * @example
 * ```typescript
 * class CustomPresenter extends ProgressPresenterBase {
 *   async update(content: string): Promise<void> {
 *     // Custom update logic
 *   }
 *   
 *   async clear(): Promise<void> {
 *     // Custom clear logic
 *   }
 *   
 *   async sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void> {
 *     // Custom final message logic
 *   }
 * }
 * ```
 */
export abstract class ProgressPresenterBase extends CliProgressPresenterBase implements ProgressPresenter {
  protected readonly channel: TextChannel;

  constructor(options: ProgressPresenterOptions) {
    super(options);
    this.channel = options.channel;
  }

  // Abstract methods are inherited from CliProgressPresenterBase
  abstract update(content: string): Promise<void>;
  abstract clear(): Promise<void>;
  abstract sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void>;
}
