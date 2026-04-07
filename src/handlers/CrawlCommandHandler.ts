import type { Message } from "discord.js";
import { runQueueCommand, type QueueResult } from "../bot/cli-runner.js";
import type { MessageCommandHandler } from "../interfaces/command-handler.js";

export interface CrawlCommandParseResult {
  isCrawlCommand: boolean;
  seedUrl: string | null;
}

export interface CrawlCommandHandlerDependencies {
  runQueue?: typeof runQueueCommand;
}

export class CrawlCommandHandler implements MessageCommandHandler {
  private readonly queue: typeof runQueueCommand;

  constructor(dependencies: CrawlCommandHandlerDependencies = {}) {
    this.queue = dependencies.runQueue ?? runQueueCommand;
  }

  parse(content: string): CrawlCommandParseResult {
    const isCrawl = /^\s*crawl\s+/i.test(content);
    if (!isCrawl) {
      return {
        isCrawlCommand: false,
        seedUrl: null,
      };
    }

    const match = content.match(/^\s*crawl\s+(https?:\/\/[^\s]+)/i);
    return {
      isCrawlCommand: true,
      seedUrl: match ? match[1] : null,
    };
  }

  async queueSeed(message: Message, seedUrl: string): Promise<QueueResult> {
    return this.queue(seedUrl, {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    });
  }

  async handleMessage(message: Message): Promise<boolean> {
    const parsed = this.parse(message.content);
    if (!parsed.isCrawlCommand) {
      return false;
    }
    if (!parsed.seedUrl) {
      return true;
    }

    await this.queueSeed(message, parsed.seedUrl);
    return true;
  }
}
