import type { Client, Message, TextChannel } from "discord.js";
import type { Logger } from "../../logger.js";
import type { LinkRepository } from "../../db/repository.js";
import type { DocumentQueue } from "./queue.js";
import { extractUrls } from "./url.js";

export interface StartupRecoveryOptions {
  discordClient: Client;
  repository: LinkRepository;
  documentQueue: DocumentQueue;
  logger: Logger;
  channelId: string;
  // Maximum number of messages to fetch per batch (Discord API limit is 100)
  batchSize?: number;
  // Maximum total messages to process during recovery
  maxMessages?: number;
}

export interface RecoveryResult {
  messagesProcessed: number;
  messagesSkipped: {
    botMessages: number;
    noUrls: number;
    total: number;
  };
  urlsFound: number;
  urlsQueued: number;
  oldestMessageId: string | null;
  newestMessageId: string | null;
}

export class StartupRecoveryService {
  private readonly batchSize: number;
  private readonly maxMessages: number;

  constructor(private readonly options: StartupRecoveryOptions) {
    this.batchSize = options.batchSize ?? 100; // Discord max is 100
    this.maxMessages = options.maxMessages ?? 1000; // Reasonable default limit
  }

  /**
   * Perform startup recovery by fetching and processing messages since the last checkpoint.
   * Messages are fetched in chronological order (oldest first) to ensure proper sequencing.
   */
  async performRecovery(): Promise<RecoveryResult> {
    this.options.logger.info("Starting startup recovery");

    // Get the last checkpoint
    const lastCheckpoint = await this.options.repository.getCheckpoint(
      this.options.channelId
    );

    if (!lastCheckpoint) {
      this.options.logger.info("No checkpoint found, skipping startup recovery");
      return {
        messagesProcessed: 0,
        messagesSkipped: { botMessages: 0, noUrls: 0, total: 0 },
        urlsFound: 0,
        urlsQueued: 0,
        oldestMessageId: null,
        newestMessageId: null,
      };
    }

    this.options.logger.info("Recovery checkpoint loaded", {
      channelId: this.options.channelId,
      lastCheckpoint,
    });

    // Fetch the channel
    const channel = await this.options.discordClient.channels.fetch(
      this.options.channelId
    );
    if (!channel || !channel.isText()) {
      throw new Error(`Channel ${this.options.channelId} not found or not a text channel`);
    }

    const textChannel = channel as TextChannel;

    // Fetch messages after the checkpoint
    const messages = await this.fetchMessagesAfterCheckpoint(
      textChannel,
      lastCheckpoint
    );

    if (messages.length === 0) {
      this.options.logger.info("No new messages to recover");
      return {
        messagesProcessed: 0,
        messagesSkipped: { botMessages: 0, noUrls: 0, total: 0 },
        urlsFound: 0,
        urlsQueued: 0,
        oldestMessageId: null,
        newestMessageId: null,
      };
    }

    this.options.logger.info("Found messages to recover", {
      count: messages.length,
      oldestMessageId: messages[0].id,
      newestMessageId: messages[messages.length - 1].id,
    });

    // Process messages and extract URLs
    const result = await this.processMessages(messages);

    this.options.logger.info("Startup recovery completed", {
      messagesProcessed: result.messagesProcessed,
      messagesSkipped: result.messagesSkipped,
      urlsFound: result.urlsFound,
      urlsQueued: result.urlsQueued,
      oldestMessageId: result.oldestMessageId,
      newestMessageId: result.newestMessageId,
    });

    return result;
  }

  /**
   * Fetch messages after the checkpoint in chronological order.
   * Discord's fetch returns messages in reverse chronological order (newest first),
   * so we need to reverse them to process oldest first.
   */
  private async fetchMessagesAfterCheckpoint(
    channel: TextChannel,
    afterMessageId: string
  ): Promise<Message[]> {
    const allMessages: Message[] = [];
    let lastMessageId: string | undefined;

    while (allMessages.length < this.maxMessages) {
      const options: { limit: number; after?: string } = {
        limit: Math.min(this.batchSize, this.maxMessages - allMessages.length),
      };

      // After the first batch, use the last message ID to continue fetching
      if (lastMessageId) {
        options.after = lastMessageId;
      } else {
        // First batch: fetch messages after the checkpoint
        options.after = afterMessageId;
      }

      this.options.logger.debug("Fetching message batch", {
        after: options.after,
        limit: options.limit,
        fetchedSoFar: allMessages.length,
      });

      const batch = await channel.messages.fetch(options);

      if (batch.size === 0) {
        // No more messages to fetch
        break;
      }

      // Convert Collection to array and reverse to get chronological order
      // Discord returns messages newest first, we want oldest first
      const batchArray = Array.from(batch.values()).reverse();
      allMessages.push(...batchArray);

      // Update the last message ID for the next batch
      // Get the newest message ID from this batch (which is the first in the Collection)
      const newestInBatch = batch.first();
      if (newestInBatch) {
        lastMessageId = newestInBatch.id;
      }

      // If we got fewer messages than requested, we've reached the end
      if (batch.size < options.limit) {
        break;
      }
    }

    return allMessages;
  }

  /**
   * Process messages and enqueue URLs into the document queue.
   * Messages are processed in chronological order (oldest first).
   */
  private async processMessages(messages: Message[]): Promise<RecoveryResult> {
    let urlsFound = 0;
    let urlsQueued = 0;
    let botMessagesSkipped = 0;
    let noUrlsSkipped = 0;
    const oldestMessageId = messages[0]?.id ?? null;
    const newestMessageId = messages[messages.length - 1]?.id ?? null;

    // Log the start of message processing
    this.options.logger.info("Starting message processing", {
      totalMessages: messages.length,
      oldestMessageId,
      newestMessageId,
    });

    // Filter and categorize messages
    const validMessages: Message[] = [];
    
    for (const message of messages) {
      if (message.author.bot) {
        botMessagesSkipped++;
        this.options.logger.debug("Skipping bot message", {
          messageId: message.id,
          authorId: message.author.id,
        });
        continue;
      }
      
      const urls = extractUrls(message.content);
      if (urls.length === 0) {
        noUrlsSkipped++;
        this.options.logger.debug("Skipping message with no URLs", {
          messageId: message.id,
          contentPreview: message.content.slice(0, 100),
        });
        continue;
      }
      
      validMessages.push(message);
    }

    const totalSkipped = botMessagesSkipped + noUrlsSkipped;

    this.options.logger.info("Message filtering complete", {
      totalMessages: messages.length,
      messagesWithUrls: validMessages.length,
      messagesSkipped: {
        botMessages: botMessagesSkipped,
        noUrls: noUrlsSkipped,
        total: totalSkipped,
      },
      skipRate: `${((totalSkipped / messages.length) * 100).toFixed(1)}%`,
    });

    // Process valid messages
    for (let i = 0; i < validMessages.length; i++) {
      const message = validMessages[i];
      const urls = extractUrls(message.content);
      urlsFound += urls.length;

      this.options.logger.debug("Processing message for recovery", {
        messageId: message.id,
        authorId: message.author.id,
        urlCount: urls.length,
        urls,
        progress: `${i + 1}/${validMessages.length}`,
      });

      try {
        // Enqueue the entire message - the queue will handle URL extraction and deduplication
        await this.options.documentQueue.enqueue(message);
        urlsQueued += urls.length;
        
        this.options.logger.debug("Successfully enqueued message", {
          messageId: message.id,
          urlsEnqueued: urls.length,
        });
      } catch (error) {
        this.options.logger.error("Failed to enqueue message during recovery", {
          messageId: message.id,
          urlCount: urls.length,
          urls,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other messages - don't let one failure stop the recovery
      }
    }

    // Log completion summary
    this.options.logger.info("Message processing complete", {
      messagesProcessed: validMessages.length,
      messagesSkipped: {
        botMessages: botMessagesSkipped,
        noUrls: noUrlsSkipped,
        total: totalSkipped,
      },
      urlsFound,
      urlsQueued,
      urlsSuccessfullyEnqueued: `${((urlsQueued / urlsFound) * 100).toFixed(1)}%`,
    });

    return {
      messagesProcessed: validMessages.length,
      messagesSkipped: {
        botMessages: botMessagesSkipped,
        noUrls: noUrlsSkipped,
        total: totalSkipped,
      },
      urlsFound,
      urlsQueued,
      oldestMessageId,
      newestMessageId,
    };
  }
}
