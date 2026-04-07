import { describe, expect, it } from "vitest";
import {
  formatMissingCrawlSeedMessage,
  formatQueueFailureMessage,
  formatQueuedUrlMessage,
} from "../../src/presenters/queue.js";

describe("queue presenter", () => {
  it("formats missing seed prompt", () => {
    expect(formatMissingCrawlSeedMessage()).toContain("crawl https://example.com");
  });

  it("formats queued success message", () => {
    expect(formatQueuedUrlMessage("https://crawl.example/start")).toBe(
      "Queued URL for crawling: `https://crawl.example/start`"
    );
  });

  it("formats queue failure with fallback", () => {
    const msg = formatQueueFailureMessage(undefined, "fallback error");
    expect(msg).toBe("Failed to queue URL\n\nfallback error");
  });
});
