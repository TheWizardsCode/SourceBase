import { describe, expect, it } from "vitest";

import { extractUrls } from "../src/cli/lib/ingestion/url.js";

describe("extractUrls", () => {
  it("extracts unique URLs from message text", () => {
    const urls = extractUrls("Read https://a.example/x and https://b.example/y and https://a.example/x");
    expect(urls).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("strips trailing punctuation", () => {
    const urls = extractUrls("Check https://a.example/x, then https://b.example/y!");
    expect(urls).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});
