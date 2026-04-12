import type { Message } from "discord.js";
import type { QueueTransportPayload } from "../presenters/QueuePresenter.js";
import { runQueueCommand, type QueueResult } from "../bot/cli-runner.js";
import { normalizeUrl } from "../url.js";
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

    // Capture the token after the 'crawl' keyword and normalize it using
    // the shared URL utilities so punctuation and edge cases are handled
    // consistently with other ingestion paths.
    const match = content.match(/^\s*crawl\s+(\S+)/i);
    if (!match) {
      return { isCrawlCommand: true, seedUrl: null };
    }

    const raw = match[1];
    // Use the shared normalizer. It's conservative and will return a cleaned
    // string even when parsing fails.
    const normalized = normalizeUrl(raw);
    return { isCrawlCommand: true, seedUrl: normalized };
  }

  async queueSeed(message: Message, seedUrl: string): Promise<QueueResult> {
    const payload: QueueTransportPayload = {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    };

    // Prefer passing an explicit transport payload to the runner so that
    // any persistence or rehydration paths use a safe, minimal shape rather
    // than relying on synthetic Message casting.
    return this.queue(seedUrl, payload as any);
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
