import { describe, expect, it, vi } from "vitest";

import type { LinkRecord } from "../src/db/repository.js";
import { IngestionService } from "../src/ingestion/service.js";
import { Logger } from "../src/logger.js";

interface MessageStub {
  id: string;
  content: string;
  channelId: string;
  author: { id: string };
  react: (emoji: string) => Promise<void>;
}

describe("IngestionService", () => {
  it("extracts and stores URLs from messages", async () => {
    const upsertLink = vi.fn<(_link: LinkRecord) => Promise<void>>().mockResolvedValue(undefined);
    const service = new IngestionService({
      repository: { upsertLink },
      extractor: {
        extract: async (url: string) => ({
          url,
          title: "Extracted title",
          content: "Extracted content",
          imageUrl: "https://img.example/1.png",
          metadata: { source: "test" }
        })
      },
      summarizer: {
        summarize: async () => "Generated summary"
      },
      embedder: {
        embed: async () => [0.1, 0.2, 0.3]
      },
      logger: new Logger("error"),
      failureReaction: "⚠️"
    });

    const react = vi.fn().mockResolvedValue(undefined);
    const message: MessageStub = {
      id: "m1",
      content: "check https://example.com/post",
      channelId: "c1",
      author: { id: "u1" },
      react
    };

    await service.ingestMessage(message as never);

    expect(upsertLink).toHaveBeenCalledTimes(1);
    expect(upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Generated summary",
        embedding: [0.1, 0.2, 0.3]
      })
    );
    expect(react).not.toHaveBeenCalled();
  });

  it("reacts on extraction failure", async () => {
    const upsertLink = vi.fn<(_link: LinkRecord) => Promise<void>>().mockResolvedValue(undefined);
    const service = new IngestionService({
      repository: { upsertLink },
      extractor: {
        extract: async () => {
          throw new Error("boom");
        }
      },
      summarizer: {
        summarize: async () => "Generated summary"
      },
      embedder: {
        embed: async () => [0.1, 0.2, 0.3]
      },
      logger: new Logger("error"),
      failureReaction: "⚠️"
    });

    const react = vi.fn().mockResolvedValue(undefined);
    const message: MessageStub = {
      id: "m2",
      content: "read https://example.com/failure",
      channelId: "c1",
      author: { id: "u1" },
      react
    };

    await service.ingestMessage(message as never);

    expect(react).toHaveBeenCalledWith("⚠️");
  });
});
