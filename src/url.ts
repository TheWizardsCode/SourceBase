/**
 * Shared URL extraction and normalization utilities.
 * Centralises the URL regex and dedupe/normalization rules so all
 * ingestion and queueing code paths behave consistently.
 */

export function normalizeUrl(raw: string): string {
  // Trim surrounding whitespace
  let u = String(raw).trim();

  // Strip surrounding common punctuation in prose: leading '((["', trailing '.,;:!?)"]' etc.
  u = u.replace(/^[\(<\["']+/g, "");
  u = u.replace(/[.,;:!?)"'\]]+$/g, "");

  // Try to parse and canonicalise using the WHATWG URL.
  try {
    const url = new URL(u);

    // Remove credentials
    url.username = "";
    url.password = "";

    // Lowercase the hostname (authority is case-insensitive)
    url.hostname = url.hostname.toLowerCase();

    // Remove default ports for http/https
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }

    // Canonicalise trailing slash: remove trailing slash for non-empty paths
    // and remove root slash so origin-only URLs become 'https://example.com'
    if (url.pathname === "/") {
      url.pathname = "";
    } else if (url.pathname && url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }

    // Build origin + path + search + hash to avoid embedding credentials
    let result = `${url.origin}${url.pathname}${url.search}${url.hash}`;
    // Remove any accidental trailing slashes (e.g. from non-root paths).
    // This is conservative and matches expectations in the test-suite.
    result = result.replace(/\/+$/g, "");
    return result;
  } catch {
    return u;
  }
}

/**
 * Extract URLs from arbitrary text content.
 * Deduplicates while preserving first-seen order.
 */
export function extractUrls(content: string): string[] {
  if (!content) return [];
  // Regex mirrors the previous local implementations but centralised here.
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = content.match(urlRegex) || [];
  const normalized = matches.map((m) => normalizeUrl(m));
  // Preserve insertion order while removing duplicates
  return [...new Set(normalized)];
}

/**
 * Quick test whether the content contains at least one URL.
 */
export function containsUrl(content: string): boolean {
  if (!content) return false;
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/i;
  return urlRegex.test(content);
}
