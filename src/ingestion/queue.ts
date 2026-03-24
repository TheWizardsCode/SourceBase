import type { Message } from "discord.js";
import type { Logger } from "../logger.js";
import type { IngestionService } from "./service.js";
import { DocumentQueueRepository } from "../db/queue-repository.js";

export interface PendingQueueItem {
  url: string;
  discordMessageId: string;
  discordChannelId: string;
  discordAuthorId: string;
  dbId: number;
}

export interface QueueItem {
  message: Message;
  url: string;
  dbId?: number;
}

export type QueueUpdateStatus = 'added' | 'processing' | 'skipped';

export interface DocumentQueueOptions {
  logger: Logger;
  ingestionService: IngestionService;
  repository: DocumentQueueRepository;
  onQueueUpdate?: (item: QueueItem, queueSize: number, status: QueueUpdateStatus) => Promise<void>;
}

export class DocumentQueue {
  private queue: QueueItem[] = [];
  private currentItem: QueueItem | null = null;
  private isProcessing = false;

  constructor(private readonly options: DocumentQueueOptions) {}

  /**
   * Initialize the queue by loading pending items from database
   * Returns the loaded pending items with Discord metadata for status message restoration
   */
  async initialize(): Promise<PendingQueueItem[]> {
    this.options.logger.info("Initializing document queue from database");
    const pendingEntries = await this.options.repository.getPending();
    
    const pendingItems: PendingQueueItem[] = [];

    for (const entry of pendingEntries) {
      // Create a minimal message-like object with necessary fields
      const syntheticMessage = {
        id: entry.discordMessageId,
        channelId: entry.discordChannelId,
        channel: { type: 'GUILD_TEXT' },
        author: { id: entry.discordAuthorId },
        content: entry.url,
        client: { user: { id: '' } },
        react: async () => {},
        reply: async () => {},
      } as unknown as Message;

      this.queue.push({
        message: syntheticMessage,
        url: entry.url,
        dbId: entry.id,
      });

      // Track pending items for status restoration
      pendingItems.push({
        url: entry.url,
        discordMessageId: entry.discordMessageId,
        discordChannelId: entry.discordChannelId,
        discordAuthorId: entry.discordAuthorId,
        dbId: entry.id,
      });
    }

    this.options.logger.info("Loaded pending URLs from database", {
      count: this.queue.length,
    });

    // Start processing if we have items
    if (this.queue.length > 0) {
      this.processQueue();
    }

    return pendingItems;
  }

  /**
   * Add a message to the processing queue
   * Each URL becomes a separate queue item for independent processing
   * Checks for duplicates and skips URLs already in the queue
   */
  async enqueue(message: Message): Promise<void> {
    const urls = this.extractUrls(message.content);
    await this.enqueueUrls(urls, message);
  }

  /**
   * Add URLs directly to the queue (used for crawl discovered URLs)
   * Checks for duplicates and skips URLs already in the queue
   */
  async enqueueUrls(urls: string[], message: Message): Promise<void> {
    if (urls.length === 0) {
      return;
    }

    // Get currently queued URLs from database
    const queuedUrls = await this.options.repository.getAllPendingUrls();
    const queuedSet = new Set(queuedUrls);

    // Check for duplicates and create items for new URLs
    const duplicateUrls: string[] = [];
    const newItems: QueueItem[] = [];

    for (const url of urls) {
      if (queuedSet.has(url) || this.isUrlBeingProcessed(url)) {
        duplicateUrls.push(url);
      } else {
        newItems.push({ message, url });
        queuedSet.add(url);
      }
    }

    // Report skipped duplicates
    if (duplicateUrls.length > 0) {
      this.options.logger.info("Skipping duplicate URLs", {
        messageId: message.id,
        duplicates: duplicateUrls,
        queueSize: this.queue.length,
      });

      if (this.options.onQueueUpdate) {
        for (const url of duplicateUrls) {
          const skipItem: QueueItem = { message, url };
          await this.options.onQueueUpdate(skipItem, this.queue.length, 'skipped');
        }
      }
    }

    // If no new URLs, we're done
    if (newItems.length === 0) {
      return;
    }

    // Save to database and add to queue
    for (const item of newItems) {
      const entry = await this.options.repository.create({
        url: item.url,
        discordMessageId: item.message.id,
        discordChannelId: item.message.channelId,
        discordAuthorId: item.message.author.id,
      });
      item.dbId = entry.id;
      this.queue.push(item);
    }

    const queueSizeAfterAdd = this.queue.length;

    this.options.logger.info("URLs queued for processing", {
      messageId: message.id,
      urls: newItems.length,
      skipped: duplicateUrls.length,
      queueSize: queueSizeAfterAdd,
    });

    // Notify about queue updates for each new URL
    if (this.options.onQueueUpdate) {
      for (const item of newItems) {
        await this.options.onQueueUpdate(item, queueSizeAfterAdd, 'added');
      }
    }

    // Start processing if not already running
    this.processQueue();
  }

  /**
   * Get the current queue size (excluding the item being processed)
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is currently processing an item
   */
  isProcessingItem(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current item being processed
   */
  getCurrentItem(): QueueItem | null {
    return this.currentItem;
  }

  /**
   * Check if a URL is currently being processed
   */
  private isUrlBeingProcessed(url: string): boolean {
    if (!this.currentItem) return false;
    return this.currentItem.url === url;
  }

  /**
   * Process items in the queue one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.currentItem = item;

      const remainingInQueue = this.queue.length;

      this.options.logger.info("Starting to process queued URL", {
        messageId: item.message.id,
        url: item.url,
        remainingInQueue,
      });

      // Update database status to processing
      if (item.dbId) {
        await this.options.repository.markProcessing(item.dbId);
      }

      // Notify about queue update (Processing from queue)
      if (this.options.onQueueUpdate) {
        await this.options.onQueueUpdate(item, remainingInQueue, 'processing');
      }

      try {
        await this.options.ingestionService.ingestMessage(item.message, {
          urls: [item.url],
          currentIndex: 0,
          queueSize: remainingInQueue,
        });

        // Mark as completed in database
        if (item.dbId) {
          await this.options.repository.markCompleted(item.dbId);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.options.logger.error("Failed to process queued URL", {
          messageId: item.message.id,
          url: item.url,
          error: errorMessage,
        });

        // Mark as failed in database
        if (item.dbId) {
          await this.options.repository.markFailed(item.dbId, errorMessage);
        }
      }
    }

    this.currentItem = null;
    this.isProcessing = false;
  }

  /**
   * Extract URLs from message content
   */
  private extractUrls(content: string): string[] {
    const matches = content.match(/https?:\/\/[^\s]+/g);
    return matches || [];
  }
}
