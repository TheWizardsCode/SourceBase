import type { Message } from "discord.js";

import type { LinkRecord } from "../db/repository.js";
import type { Logger } from "../logger.js";
import { extractUrls } from "./url.js";
import type { ContentExtractor } from "./extractor.js";

export interface LinkStore {
  upsertLink(link: LinkRecord): Promise<unknown>;
}

export interface IngestionServiceOptions {
  repository: LinkStore;
  extractor: ContentExtractor;
  summarizer: {
    summarize(content: string): Promise<string>;
  };
  embedder: {
    embed(text: string): Promise<number[]>;
  };
  logger: Logger;
  failureReaction: string;
}

export class IngestionService {
  constructor(private readonly options: IngestionServiceOptions) {}

  async ingestMessage(message: Message): Promise<void> {
    const urls = extractUrls(message.content);
    if (!urls.length) {
      return;
    }

    for (const url of urls) {
      try {
        const extracted = await this.options.extractor.extract(url);
        if (!extracted) {
          throw new Error("No extractable article content returned");
        }

        const baseTextForLlm = [extracted.title, extracted.content].filter(Boolean).join("\n\n").trim();
        const summary = baseTextForLlm ? await this.options.summarizer.summarize(baseTextForLlm) : null;
        const embeddingText = [extracted.title, summary, extracted.content].filter(Boolean).join("\n\n").trim();
        const embedding = embeddingText ? await this.options.embedder.embed(embeddingText) : null;

        await this.options.repository.upsertLink({
          url,
          title: extracted.title,
          summary,
          content: extracted.content,
          imageUrl: extracted.imageUrl,
          embedding,
          metadata: {
            ...extracted.metadata,
            discordMessageId: message.id,
            discordChannelId: message.channelId,
            discordAuthorId: message.author.id
          }
        });

        this.options.logger.info("Ingested URL from message", {
          url,
          messageId: message.id
        });
      } catch (error) {
        this.options.logger.warn("Failed to ingest URL", {
          url,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });

        await message.react(this.options.failureReaction);
      }
    }
  }
}
