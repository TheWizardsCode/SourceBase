import type { Message } from "discord.js";
import type { Logger } from "../logger.js";
import type { IngestionService } from "./service.js";

export interface QueueItem {
  message: Message;
  urls: string[];
  currentIndex: number;
}

export interface DocumentQueueOptions {
  logger: Logger;
  ingestionService: IngestionService;
}

export class DocumentQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private currentItem: QueueItem | null = null;

  constructor(private readonly options: DocumentQueueOptions) {}

  /**
   * Add a message to the processing queue
   */
  enqueue(message: Message): void {
    const urls = this.extractUrls(message.content);
    if (urls.length === 0) {
      return;
    }

    const item: QueueItem = {
      message,
      urls,
      currentIndex: 0,
    };

    this.queue.push(item);
    this.options.logger.info("Message queued for processing", {
      messageId: message.id,
      urls: urls.length,
      queueSize: this.queue.length,
    });

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

      this.options.logger.info("Starting to process queued message", {
        messageId: item.message.id,
        urls: item.urls.length,
        remainingInQueue: this.queue.length,
      });

      try {
        await this.options.ingestionService.ingestMessage(item.message, {
          urls: item.urls,
          currentIndex: item.currentIndex,
          queueSize: this.queue.length,
        });
      } catch (error) {
        this.options.logger.error("Failed to process queued item", {
          messageId: item.message.id,
          error: error instanceof Error ? error.message : String(error),
        });
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
