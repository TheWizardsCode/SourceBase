import type { Client, Message, TextChannel } from "discord.js";
import type { Logger } from "../logger.js";
import type { LinkRepository } from "../db/repository.js";
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
      urlsFound: result.urlsFound,
      urlsQueued: result.urlsQueued,
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
    const oldestMessageId = messages[0]?.id ?? null;
    const newestMessageId = messages[messages.length - 1]?.id ?? null;

    // Filter out bot messages and messages without URLs
    const validMessages = messages.filter((message) => {
      if (message.author.bot) {
        return false;
      }
      const urls = extractUrls(message.content);
      return urls.length > 0;
    });

    this.options.logger.info("Processing messages with URLs", {
      totalMessages: messages.length,
      messagesWithUrls: validMessages.length,
    });

    for (const message of validMessages) {
      const urls = extractUrls(message.content);
      urlsFound += urls.length;

      this.options.logger.debug("Enqueuing message URLs", {
        messageId: message.id,
        urlCount: urls.length,
        urls,
      });

      try {
        // Enqueue the entire message - the queue will handle URL extraction and deduplication
        await this.options.documentQueue.enqueue(message);
        urlsQueued += urls.length;
      } catch (error) {
        this.options.logger.error("Failed to enqueue message during recovery", {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other messages - don't let one failure stop the recovery
      }
    }

    return {
      messagesProcessed: validMessages.length,
      urlsFound,
      urlsQueued,
      oldestMessageId,
      newestMessageId,
    };
  }
}
