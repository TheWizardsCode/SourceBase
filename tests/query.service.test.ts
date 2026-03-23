import { describe, expect, it } from "vitest";

import type { StoredLink } from "../src/db/repository.js";
import { QueryService } from "../src/query/service.js";

describe("QueryService", () => {
  it("formats ranked semantic results", async () => {
    const service = new QueryService(
      {
        searchSimilarLinks: async () => [
          createLink("https://example.com/a", "A title", "A summary"),
          createLink("https://example.com/b", "B title", "B summary")
        ]
      },
      {
        embed: async () => [0.1, 0.2, 0.3]
      }
    );

    const reply = await service.answerQuery("what was shared about bots?");
    expect(reply).toContain("Here are the most relevant links I found:");
    expect(reply).toContain("1. A title");
    expect(reply).toContain("2. B title");
  });

  it("returns fallback text when no matches exist", async () => {
    const service = new QueryService(
      {
        searchSimilarLinks: async () => []
      },
      {
        embed: async () => [0.1]
      }
    );

    const reply = await service.answerQuery("anything on abc");
    expect(reply).toBe("I could not find any previously shared links for that query yet.");
  });
});

function createLink(url: string, title: string, summary: string): StoredLink {
  return {
    id: 1,
    url,
    canonicalUrl: null,
    title,
    summary,
    content: null,
    transcript: null,
    imageUrl: null,
    metadata: {},
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
