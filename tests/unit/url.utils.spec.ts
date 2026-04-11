import { describe, it, expect } from "vitest";
import { normalizeUrl, extractUrls, containsUrl } from "../../src/url.js";

describe("url utilities", () => {
  it("normalizes trailing punctuation", () => {
    expect(normalizeUrl("https://example.com/path,")) .toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com/path.")) .toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com/path)")) .toBe("https://example.com/path");
  });

  it("normalizes leading punctuation", () => {
    expect(normalizeUrl("(https://x.example)")) .toBe("https://x.example");
    expect(normalizeUrl('"https://x.example"')) .toBe("https://x.example");
  });

  it("extracts and deduplicates urls preserving order", () => {
    const input = "https://one.example/a and https://two.example/b and again https://one.example/a";
    expect(extractUrls(input)).toEqual(["https://one.example/a", "https://two.example/b"]);
  });

  it("handles edge-case url formats", () => {
    const input = "Check this: https://example.com/path?query=1&other=2. Also (https://bracket.example/page).";
    const urls = extractUrls(input);
    expect(urls).toContain("https://example.com/path?query=1&other=2");
    expect(urls).toContain("https://bracket.example/page");
  });

  it("normalizes hostname case, removes default ports and trailing slash", () => {
    expect(normalizeUrl("HTTP://Example.COM:80/path/")).toBe("http://example.com/path");
    expect(normalizeUrl("https://Example.COM:443/path/")).toBe("https://example.com/path");
  });

  it("normalizes origin-only URLs to omit trailing slash", () => {
    expect(normalizeUrl("https://Example.COM/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("removes multiple trailing slashes on paths and origins", () => {
    expect(normalizeUrl("https://example.com/path///")).toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com////")).toBe("https://example.com");
  });

  it("strips surrounding punctuation from URLs with query strings", () => {
    expect(normalizeUrl("https://example.com/path?query=1,")).toBe("https://example.com/path?query=1");
    expect(normalizeUrl("(https://example.com/search?q=test.)")).toBe("https://example.com/search?q=test");
  });

  it("removes credentials from URLs", () => {
    expect(normalizeUrl("https://user:pass@example.com/path")).toBe("https://example.com/path");
  });

  it("containsUrl detects urls", () => {
    expect(containsUrl("no url here")).toBe(false);
    expect(containsUrl("visit https://a.example now")).toBe(true);
  });
});
