/**
 * QueuePresenter interface for formatting and managing queue status messages
 * 
 * This interface abstracts the presentation logic for document queue updates,
 * separating the queue management logic from Discord message formatting.
 * 
 * @module queue-presenter
 * @example
 * ```typescript
 * // Discord implementation
 * class DiscordQueuePresenter implements QueuePresenter {
 *   private queueMessages = new Map<string, Message>();
 *   
 *   constructor(
 *     private readonly channelCache: Map<string, TextChannel>,
 *     private readonly logger: Logger
 *   ) {}
 *   
 *   format(url: string, queueSize: number, status: QueueUpdateStatus): string {
 *     const urlDisplay = url.length > 60 ? url.slice(0, 57) + '...' : url;
 *     
 *     switch (status) {
 *       case 'skipped':
 *         return `⏭️ Skipping <${urlDisplay}> as it is already in the queue. Queue length: ${queueSize}`;
 *       case 'added':
 *         return `📥 Added <${urlDisplay}> to Queue. Queue length: ${queueSize}`;
 *       case 'processing':
 *         return `⚙️ Processing <${urlDisplay}> from the Queue. Queue length: ${queueSize}`;
 *     }
 *   }
 *   
 *   async update(channelId: string, content: string): Promise<void> {
 *     // Delete previous message for this channel
 *     const previous = this.queueMessages.get(channelId);
 *     if (previous) {
 *       await previous.delete().catch(() => {});
 *     }
 *     
 *     // Send new message
 *     const channel = this.channelCache.get(channelId);
 *     if (channel) {
 *       const message = await channel.send(content);
 *       this.queueMessages.set(channelId, message);
 *     }
 *   }
 *   
 *   async clear(channelId?: string): Promise<void> {
 *     if (channelId) {
 *       const message = this.queueMessages.get(channelId);
 *       if (message) {
 *         await message.delete().catch(() => {});
 *         this.queueMessages.delete(channelId);
 *       }
 *     } else {
 *       // Clear all
 *       for (const [id, message] of this.queueMessages) {
 *         await message.delete().catch(() => {});
 *       }
 *       this.queueMessages.clear();
 *     }
 *   }
 * }
 * ```
 */

import type { Message, TextChannel } from "discord.js";
import type { QueueUpdateStatus, CliQueueItem, Logger } from "./cli-types.js";

/**
 * Configuration options for queue presenters
 */
export interface QueuePresenterOptions {
  /** Map of channel ID to TextChannel for sending messages */
  channelCache: Map<string, TextChannel>;
  /** Logger instance */
  logger: Logger;
  /** Maximum URL display length in messages */
  maxUrlDisplayLength?: number;
  /** Whether to show queue length in messages */
  showQueueLength?: boolean;
}

/**
 * Interface for queue status message presenters
 * 
 * Implementations handle the formatting, display, and cleanup of queue
 * status messages. This abstraction allows for:
 * - Testing without Discord API calls
 * - Different presentation strategies (Discord, CLI, webhooks, etc.)
 * - Per-channel message management
 * 
 * @example
 * ```typescript
 * // Usage in document queue
 * class DocumentQueue {
 *   constructor(private readonly presenter: QueuePresenter) {}
 *   
   *   async onQueueUpdate(item: CliQueueItem, queueSize: number, status: QueueUpdateStatus): Promise<void> {
   *     const channelId = item.channelId;
 *     const content = this.presenter.format(item.url, queueSize, status);
 *     
 *     // Don't show queue status if queue is empty
 *     if (queueSize === 0 && status !== 'processing') {
 *       await this.presenter.clear(channelId);
 *       return;
 *     }
 *     
 *     await this.presenter.update(channelId, content);
 *   }
 * }
 * ```
 */
export interface QueuePresenter {
  /**
   * Format a queue update into a display string
   * 
   * @param url - The URL being processed or queued
   * @param queueSize - Current size of the queue
   * @param status - The status of this queue update
   * @returns Formatted message string ready for display
   * 
   * @example
   * ```typescript
   * const content = presenter.format("https://example.com", 5, "added");
   * // Returns: "📥 Added <https://example.com> to Queue. Queue length: 5"
   * 
   * const processing = presenter.format("https://example.com", 4, "processing");
   * // Returns: "⚙️ Processing <https://example.com> from the Queue. Queue length: 4"
   * 
   * const skipped = presenter.format("https://example.com", 5, "skipped");
   * // Returns: "⏭️ Skipping <https://example.com> as it is already in the queue. Queue length: 5"
   * ```
   */
  format(url: string, queueSize: number, status: QueueUpdateStatus): string;

  /**
   * Update or create the queue status message for a channel
   * 
   * Creates a new message on first call for a channel, replaces existing
   * message on subsequent calls. Each channel maintains its own queue status
   * message.
   * 
   * @param channelId - The Discord channel ID
   * @param content - The formatted queue status message
   * @returns Promise resolving when the update is complete
   * @throws Should catch Discord API errors and log them, not throw
   * 
   * @example
   * ```typescript
   * await presenter.update("123456789", "📥 Added <https://example.com> to Queue. Queue length: 1");
   * // Later...
   * await presenter.update("123456789", "⚙️ Processing <https://example.com> from the Queue. Queue length: 0");
   * ```
   */
  update(channelId: string, content: string): Promise<void>;

  /**
   * Clear/remove queue status message(s)
   * 
   * If channelId is provided, clears only that channel's message.
   * If no channelId is provided, clears all queue status messages.
   * 
   * @param channelId - Optional specific channel to clear
   * @returns Promise resolving when cleanup is complete
   * @throws Should catch Discord API errors and log them, not throw
   * 
   * @example
   * ```typescript
   * // Clear specific channel
   * await presenter.clear("123456789");
   * 
   * // Clear all channels
   * await presenter.clear();
   * ```
   */
  clear(channelId?: string): Promise<void>;

  /**
   * Send a batch summary message
   * 
   * Sends a message summarizing the results of processing multiple URLs.
   * This is typically called after a batch completes.
   * 
   * @param channelId - The Discord channel ID
   * @param processed - Number of URLs successfully processed
   * @param failed - Number of URLs that failed
   * @param total - Total number of URLs in the batch
   * @returns Promise resolving when the message is sent
   * 
   * @example
   * ```typescript
   * await presenter.sendBatchSummary("123456789", 5, 1, 6);
   * // Sends: "📊 Batch complete: 5 succeeded, 1 failed (6 total)"
   * ```
   */
  sendBatchSummary(channelId: string, processed: number, failed: number, total: number): Promise<void>;
}

/**
 * Factory for creating queue presenters
 * 
 * @param options - Configuration options
 * @returns New QueuePresenter instance
 * 
 * @example
 * ```typescript
 * const presenter = createQueuePresenter({
 *   channelCache,
 *   logger,
 *   maxUrlDisplayLength: 60
 * });
 * ```
 */
export type QueuePresenterFactory = (options: QueuePresenterOptions) => QueuePresenter;

/**
 * Status emoji mapping for queue updates
 */
export const QUEUE_STATUS_EMOJI: Record<QueueUpdateStatus, string> = {
  added: "📥",
  processing: "⚙️",
  skipped: "⏭️"
};

/**
 * Status verb mapping for queue updates
 */
export const QUEUE_STATUS_VERB: Record<QueueUpdateStatus, string> = {
  added: "Added",
  processing: "Processing",
  skipped: "Skipping"
};

/**
 * Status preposition mapping for queue updates
 */
export const QUEUE_STATUS_PREPOSITION: Record<QueueUpdateStatus, string> = {
  added: "to",
  processing: "from",
  skipped: "as it is already in"
};

/**
 * Base class with common formatting utilities
 * 
 * Extend this class to create custom queue presenters with
 * consistent formatting behavior.
 * 
 * @example
 * ```typescript
 * class CustomQueuePresenter extends QueuePresenterBase {
 *   async update(channelId: string, content: string): Promise<void> {
 *     // Custom update logic
 *   }
 *   
 *   async clear(channelId?: string): Promise<void> {
 *     // Custom clear logic
 *   }
 *   
 *   async sendBatchSummary(channelId: string, processed: number, failed: number, total: number): Promise<void> {
 *     // Custom summary logic
 *   }
 * }
 * ```
 */
export abstract class QueuePresenterBase implements QueuePresenter {
  protected readonly maxUrlDisplayLength: number;
  protected readonly showQueueLength: boolean;

  constructor(options: QueuePresenterOptions) {
    this.maxUrlDisplayLength = options.maxUrlDisplayLength ?? 60;
    this.showQueueLength = options.showQueueLength ?? true;
  }

  /**
   * Format a queue update into a display string
   */
  format(url: string, queueSize: number, status: QueueUpdateStatus): string {
    const emoji = QUEUE_STATUS_EMOJI[status];
    const verb = QUEUE_STATUS_VERB[status];
    const preposition = QUEUE_STATUS_PREPOSITION[status];
    
    // Truncate long URLs for display
    const urlDisplay = url.length > this.maxUrlDisplayLength 
      ? url.slice(0, this.maxUrlDisplayLength - 3) + '...' 
      : url;

    if (status === 'skipped') {
      return `${emoji} ${verb} <${urlDisplay}> ${preposition} the queue.${this.showQueueLength ? ` Queue length: ${queueSize}` : ''}`;
    }

    return `${emoji} ${verb} <${urlDisplay}> ${preposition} Queue.${this.showQueueLength ? ` Queue length: ${queueSize}` : ''}`;
  }

  /**
   * Format a batch summary message
   */
  protected formatBatchSummary(processed: number, failed: number, total: number): string {
    if (failed > 0) {
      return `📊 Final: ${processed} succeeded, ${failed} failed`;
    }
    return `✅ All ${processed} URLs processed successfully`;
  }

  abstract update(channelId: string, content: string): Promise<void>;
  abstract clear(channelId?: string): Promise<void>;
  abstract sendBatchSummary(channelId: string, processed: number, failed: number, total: number): Promise<void>;
}
