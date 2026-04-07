import { describe, expect, it, vi } from "vitest";
import { CrawlCommandHandler } from "../../src/handlers/CrawlCommandHandler.js";

describe("CrawlCommandHandler", () => {
  it("detects crawl commands and extracts a seed URL", () => {
    const handler = new CrawlCommandHandler();
    const parsed = handler.parse("crawl https://example.com/path");

    expect(parsed.isCrawlCommand).toBe(true);
    expect(parsed.seedUrl).toBe("https://example.com/path");
  });

  it("recognizes crawl commands with missing URL", () => {
    const handler = new CrawlCommandHandler();
    const parsed = handler.parse("crawl   ");

    expect(parsed.isCrawlCommand).toBe(true);
    expect(parsed.seedUrl).toBe(null);
  });

  it("returns not-crawl for non-crawl content", () => {
    const handler = new CrawlCommandHandler();
    const parsed = handler.parse("please queue this later");

    expect(parsed.isCrawlCommand).toBe(false);
    expect(parsed.seedUrl).toBe(null);
  });

  it("queues the seed URL with message context", async () => {
    const queueMock = vi.fn(async () => ({ success: true, url: "https://example.com" }));
    const handler = new CrawlCommandHandler({ runQueue: queueMock as any });

    const message: any = {
      channelId: "channel-1",
      id: "message-1",
      author: { id: "author-1" },
    };

    await handler.queueSeed(message, "https://example.com");

    expect(queueMock).toHaveBeenCalledWith("https://example.com", {
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "author-1",
    });
  });

  it("handleMessage returns false for non-crawl content", async () => {
    const queueMock = vi.fn();
    const handler = new CrawlCommandHandler({ runQueue: queueMock as any });

    const message: any = {
      content: "hello world",
      channelId: "channel-1",
      id: "message-1",
      author: { id: "author-1" },
    };

    const handled = await handler.handleMessage(message);
    expect(handled).toBe(false);
    expect(queueMock).not.toHaveBeenCalled();
  });
});
