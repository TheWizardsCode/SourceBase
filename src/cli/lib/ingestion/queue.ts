import type { Logger } from "../logger.js";
import type { IngestionService } from "./service.js";
import { DocumentQueueRepository } from "../db/queue-repository.js";
import type { PendingQueueItem, SyntheticMessage } from "../../../interfaces/cli-types.js";

export interface QueueItem {
  message: SyntheticMessage;
  url: string;
  dbId?: number;
}

export type QueueUpdateStatus = 'added' | 'processing' | 'skipped';

export interface DocumentQueueOptions {
  logger: Logger;
  ingestionService: IngestionService;
  repository: DocumentQueueRepository;
  onQueueUpdate?: (item: QueueItem, queueSize: number, status: QueueUpdateStatus) => Promise<void>;
  /** Poll interval in milliseconds to look for pending DB entries added externally */
  pollIntervalMs?: number;
}

export class DocumentQueue {
  private queue: QueueItem[] = [];
  private currentItem: QueueItem | null = null;
  private isProcessing = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInProgress = false;

  constructor(private readonly options: DocumentQueueOptions) {}

  /**
   * Initialize the queue by loading pending items from database
   * Returns the loaded pending items with Discord metadata for status message restoration
   */
  async initialize(): Promise<PendingQueueItem[]> {
    this.options.logger.info("Initializing document queue from database");
    
    // Reset any 'processing' items to 'pending' (they were interrupted)
    const resetCount = await this.options.repository.resetProcessingToPending();
    if (resetCount > 0) {
      this.options.logger.info("Reset processing items to pending", {
        count: resetCount,
      });
    }
    
    const pendingEntries = await this.options.repository.getPending();
    
    const pendingItems: PendingQueueItem[] = [];

    for (const entry of pendingEntries) {
      // Create a minimal SyntheticMessage object with necessary fields
      const syntheticMessage: SyntheticMessage = {
        id: entry.sourceId,
        channelId: entry.sourceContext,
        authorId: entry.authorId,
        content: entry.url,
        client: { user: { id: '' } },
        react: async () => {},
        // DB-derived pending items are not bot messages
        isBot: false,
      };

      this.queue.push({
        message: syntheticMessage,
        url: entry.url,
        dbId: entry.id,
      });

      // Track pending items for status restoration
      pendingItems.push({
        url: entry.url,
        sourceId: entry.sourceId,
        sourceContext: entry.sourceContext,
        authorId: entry.authorId,
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

    // Start background polling for externally-added DB entries
    if (this.options.pollIntervalMs && this.options.pollIntervalMs > 0) {
      this.startPolling();
    }

    return pendingItems;
  }

  /**
   * Add a message to the processing queue
   * Each URL becomes a separate queue item for independent processing
   * Checks for duplicates and skips URLs already in the queue
   */
  async enqueue(message: SyntheticMessage): Promise<void> {
    const urls = this.extractUrls(message.content);
    await this.enqueueUrls(urls, message);
  }

  /**
   * Start polling the database for pending entries that may have been added externally
   */
  private startPolling(): void {
    if (this.pollTimer) return;
    const interval = this.options.pollIntervalMs!;
    this.pollTimer = setInterval(async () => {
      if (this.pollInProgress) return;
      this.pollInProgress = true;
      try {
        // Fetch pending URLs from DB and compare with in-memory queue
        const pendingUrls = await this.options.repository.getAllPendingUrls();
        const queuedSet = new Set(this.queue.map(i => i.url));
        if (this.currentItem) queuedSet.add(this.currentItem.url);

        const newUrls = pendingUrls.filter(u => !queuedSet.has(u));
        if (newUrls.length === 0) return;

        // For discovered external URLs create synthetic message placeholders.
        // Try to use metadata from the DB entry when available (channel, author, id).
        for (const url of newUrls) {
          const entry = await this.options.repository.getByUrl(url);

          const syntheticMessage: SyntheticMessage = {
            id: entry ? entry.sourceId : `db-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            channelId: entry ? entry.sourceContext : "",
            authorId: entry ? entry.authorId : 'external',
            content: url,
            client: { user: { id: '' } },
            react: async () => {},
            // External/DB-discovered entries should not be treated as bot messages
            isBot: false,
          };

          const item: QueueItem = { message: syntheticMessage, url };
          if (entry) item.dbId = entry.id;

          this.queue.push(item);

          if (this.options.onQueueUpdate) {
            await this.options.onQueueUpdate(item, this.queue.length, 'added');
          }
        }

        // Kick the processor
        this.processQueue();
      } catch (err) {
        this.options.logger.warn("Polling for external queue items failed", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.pollInProgress = false;
      }
    }, interval);
  }

  /**
   * Stop background polling (used during shutdown)
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Add URLs directly to the queue (used for crawl discovered URLs)
   * Checks for duplicates and skips URLs already in the queue
   */
  async enqueueUrls(urls: string[], message: SyntheticMessage): Promise<void> {
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
        sourceId: item.message.id,
        sourceContext: item.message.channelId,
        authorId: item.message.authorId,
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
   * Re-queue the current processing item to the front of the queue.
   * Used during graceful shutdown to preserve interrupted items.
   */
  requeueCurrentItem(): void {
    if (this.currentItem) {
      const url = this.currentItem.url;
      this.queue.unshift(this.currentItem);
      this.currentItem = null;
      this.options.logger.info("Re-queued current item to front of queue", {
        url,
      });
    }
  }

  /**
   * Get all items in the queue (for graceful shutdown cleanup)
   */
  getQueueItems(): QueueItem[] {
    return [...this.queue];
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
        // Convert Discord Message to SyntheticMessage for ingestion
        // Note: We cast through unknown because Discord's Message type has more
        // specific types than SyntheticMessage, but they're runtime-compatible
        const syntheticMessage: SyntheticMessage = {
          id: item.message.id,
          channelId: item.message.channelId,
          authorId: item.message.authorId,
          content: item.message.content,
          client: item.message.client ? { user: item.message.client.user } : undefined,
          reactions: item.message.reactions,
          react: item.message.react?.bind(item.message),
          // Preserve isBot if present, otherwise default to false for queued items
          isBot: typeof item.message.isBot === 'boolean' ? item.message.isBot : false,
        };
        await this.options.ingestionService.ingestMessage(syntheticMessage, {
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
