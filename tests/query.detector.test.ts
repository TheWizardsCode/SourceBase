import { describe, expect, it } from "vitest";

import { isLikelyContentQuery } from "../src/query/detector.js";

describe("isLikelyContentQuery", () => {
  it("detects explicit questions", () => {
    expect(isLikelyContentQuery("What links do we have about pgvector?")).toBe(true);
    expect(isLikelyContentQuery("Any article on Discord bot retries?")).toBe(true);
  });

  it("detects implicit question + search hint", () => {
    expect(isLikelyContentQuery("how to find links about embeddings")).toBe(true);
  });

  it("ignores normal conversation", () => {
    expect(isLikelyContentQuery("great work everyone shipping today")).toBe(false);
    expect(isLikelyContentQuery("check this out https://example.com")).toBe(false);
  });
});
