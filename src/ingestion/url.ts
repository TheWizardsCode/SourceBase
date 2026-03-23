const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;
const CRAWL_REGEX = /(?:^|\s)crawl\b[\s:,-]+(https?:\/\/[^\s<>()]+)/i;
const HREF_REGEX = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const normalized = matches.map((raw) => raw.replace(/[),.;!?]+$/g, ""));
  return Array.from(new Set(normalized));
}

export function extractCrawlSeedUrl(text: string): string | null {
  const match = text.match(CRAWL_REGEX);
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/[),.;!?]+$/g, "");
}

export function normalizeDiscoveredUrls(baseUrl: string, links: string[]): string[] {
  const normalized = new Set<string>();

  for (const link of links) {
    const candidate = link.trim();
    if (!candidate) {
      continue;
    }

    try {
      const resolved = new URL(candidate, baseUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        continue;
      }

      resolved.hash = "";
      normalized.add(resolved.toString());
    } catch {
      continue;
    }
  }

  return Array.from(normalized);
}

export function extractAnchorHrefsFromHtml(html: string | null | undefined): string[] {
  if (!html) {
    return [];
  }

  const hrefs = new Set<string>();
  let match: RegExpExecArray | null = null;

  while ((match = HREF_REGEX.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3];
    const value = href?.trim();
    if (!value) {
      continue;
    }

    hrefs.add(value);
  }

  return Array.from(hrefs);
}
