import { describe, expect, it, vi } from "vitest";
import type { Client, Message, TextChannel, Collection } from "discord.js";
import { StartupRecoveryService } from "../src/ingestion/startup-recovery.js";
import type { LinkRepository } from "../src/db/repository.js";
import type { DocumentQueue } from "../src/ingestion/queue.js";
import type { Logger } from "../src/logger.js";

describe("StartupRecoveryService", () => {
  it("should skip recovery when no checkpoint exists", async () => {
    const { repository, discordClient, documentQueue, logger } = createMocks();
    
    // No checkpoint set
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
    });

    const result = await service.performRecovery();

    expect(result.messagesProcessed).toBe(0);
    expect(result.urlsFound).toBe(0);
    expect(result.urlsQueued).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "No checkpoint found, skipping startup recovery"
    );
  });

  it("should fetch and process messages after checkpoint", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    // Set checkpoint
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    // Create messages with URLs (including the checkpoint message)
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old checkpoint message", false),
      createMockMessage("msg-1", "Check out https://example.com/page1", false),
      createMockMessage("msg-2", "Here is another link: https://example.com/page2", false),
      createMockMessage("msg-3", "No URLs here", false),
      createMockMessage("msg-4", "Bot message with https://example.com/page3", true),
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
    });

    const result = await service.performRecovery();

    // Should process 2 messages with URLs (excluding bot message and message without URLs)
    expect(result.messagesProcessed).toBe(2);
    expect(result.urlsFound).toBe(2);
    expect(result.urlsQueued).toBe(2);
    expect(documentQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("should process messages in chronological order", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    // Create messages in reverse order (newest first, as Discord returns them)
    // The checkpoint message must be first in the array (oldest)
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old message", false), // checkpoint
      createMockMessage("msg-1", "https://example.com/oldest", false), // oldest after checkpoint
      createMockMessage("msg-2", "https://example.com/middle", false),
      createMockMessage("msg-3", "https://example.com/newest", false), // newest
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
    });

    await service.performRecovery();

    // Should call enqueue in chronological order (oldest first)
    const calls = vi.mocked(documentQueue.enqueue).mock.calls;
    expect(calls[0][0].id).toBe("msg-1"); // oldest first
    expect(calls[1][0].id).toBe("msg-2");
    expect(calls[2][0].id).toBe("msg-3"); // newest last
  });

  it("should handle multiple URLs in a single message", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old message", false),
      createMockMessage(
        "msg-1",
        "Here are two links: https://example.com/1 and https://example.com/2",
        false
      ),
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
    });

    const result = await service.performRecovery();

    expect(result.messagesProcessed).toBe(1);
    expect(result.urlsFound).toBe(2);
    expect(result.urlsQueued).toBe(2);
  });

  it("should handle errors gracefully and continue processing", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old message", false),
      createMockMessage("msg-1", "https://example.com/1", false),
      createMockMessage("msg-2", "https://example.com/2", false),
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    // Make the first enqueue fail
    vi.mocked(documentQueue.enqueue).mockRejectedValueOnce(new Error("Queue error"));
    vi.mocked(documentQueue.enqueue).mockResolvedValueOnce(undefined);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
    });

    const result = await service.performRecovery();

    // Should process 2 messages, but only 1 succeeds
    expect(result.messagesProcessed).toBe(2);
    expect(result.urlsFound).toBe(2);
    expect(result.urlsQueued).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to enqueue message during recovery",
      expect.objectContaining({ messageId: "msg-1" })
    );
  });

  it("should respect maxMessages limit", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    // Create more messages than the limit (including checkpoint)
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old message", false),
      ...Array.from({ length: 20 }, (_, i) =>
        createMockMessage(`msg-${i}`, `https://example.com/${i}`, false)
      ),
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
      maxMessages: 5,
    });

    const result = await service.performRecovery();

    expect(result.messagesProcessed).toBe(5);
    expect(documentQueue.enqueue).toHaveBeenCalledTimes(5);
  });

  it("should handle batch fetching correctly", async () => {
    const { repository, discordClient, documentQueue, logger, channel } = createMocks();
    
    repository.setCheckpoint("test-channel", "checkpoint-msg-id");
    
    // Create messages that require multiple batches (including checkpoint)
    const messages = [
      createMockMessage("checkpoint-msg-id", "Old message", false),
      ...Array.from({ length: 150 }, (_, i) =>
        createMockMessage(`msg-${i}`, `https://example.com/${i}`, false)
      ),
    ];
    
    (channel as MockTextChannel).setMessages(messages);
    
    const service = new StartupRecoveryService({
      discordClient,
      repository,
      documentQueue,
      logger,
      channelId: "test-channel",
      maxMessages: 150,
      batchSize: 50, // Smaller batch size for testing
    });

    const result = await service.performRecovery();

    expect(result.messagesProcessed).toBe(150);
    expect(documentQueue.enqueue).toHaveBeenCalledTimes(150);
  });
});

// Helper functions to create mocks
function createMocks() {
  const checkpoints = new Map<string, string>();
  
  const repository = {
    getCheckpoint: vi.fn((channelId: string) => {
      return Promise.resolve(checkpoints.get(channelId) || null);
    }),
    saveCheckpoint: vi.fn(),
    setCheckpoint: (channelId: string, messageId: string) => {
      checkpoints.set(channelId, messageId);
    },
  } as unknown as LinkRepository & { setCheckpoint: (channelId: string, messageId: string) => void };

  const documentQueue = {
    enqueue: vi.fn().mockResolvedValue(undefined),
  } as unknown as DocumentQueue;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const channel = createMockChannel();

  const discordClient = {
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    },
  } as unknown as Client;

  return { repository, documentQueue, logger, discordClient, channel };
}

interface MockTextChannel extends TextChannel {
  setMessages: (msgs: Message[]) => void;
}

function createMockChannel() {
  let messages: Message[] = [];
  
  return {
    isText: () => true,
    setMessages: (msgs: Message[]) => {
      messages = msgs;
    },
    messages: {
      fetch: vi.fn(async (options: { limit: number; after?: string }) => {
        // Find the index of the message after which we should fetch
        let startIndex = 0;
        if (options.after) {
          startIndex = messages.findIndex((m) => m.id === options.after);
          if (startIndex === -1) {
            return { size: 0, first: () => undefined, values: () => [] };
          }
          startIndex += 1; // Start after the checkpoint message
        }

        // Get the next batch
        const batch = messages.slice(startIndex, startIndex + options.limit);
        
        // Return in Discord's format (newest first, which means reverse of our stored order)
        const reversedBatch = [...batch].reverse();
        
        return {
          size: reversedBatch.length,
          first: () => reversedBatch[0],
          values: () => reversedBatch.values(),
        };
      }),
    },
  } as unknown as TextChannel;
}

function createMockMessage(
  id: string,
  content: string,
  isBot: boolean
): Message {
  return {
    id,
    content,
    author: {
      id: isBot ? "bot-id" : "user-id",
      bot: isBot,
    },
    channelId: "test-channel",
    channel: {
      type: "GUILD_TEXT",
    },
  } as unknown as Message;
}
