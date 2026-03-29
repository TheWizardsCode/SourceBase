const URL_REGEX = /(?:https?:\/\/|file:\/\/)[^\s<>()]+/gi;
const CRAWL_REGEX = /(?:^|\s)crawl\b[\s:,-]+(https?:\/\/[^\s<>()]+)/i;
const HREF_REGEX = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

// YouTube URL patterns
const YOUTUBE_PATTERNS = {
  standard: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i,
  short: /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})\b/i,
  shorts: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})\b/i,
  embed: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})\b/i,
  live: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})\b/i,
  mobile: /(?:https?:\/\/)?m\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i,
  music: /(?:https?:\/\/)?music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i
};

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// PDF URL patterns - detect direct links to PDF files
const PDF_PATTERN = /https?:\/\/[^\s<>()]+\.pdf(\?[^\s<>()]*)?$/i;

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
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:" && resolved.protocol !== "file:") {
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

export function isYouTubeUrl(url: string): boolean {
  return Object.values(YOUTUBE_PATTERNS).some(pattern => pattern.test(url));
}

export function extractYouTubeVideoId(url: string): string | null {
  for (const pattern of Object.values(YOUTUBE_PATTERNS)) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      if (VIDEO_ID_REGEX.test(videoId)) {
        return videoId;
      }
    }
  }
  return null;
}

export function normalizeYouTubeUrl(url: string): string | null {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// PDF URL detection
export function isPdfUrl(url: string): boolean {
  return PDF_PATTERN.test(url);
}

// File URL detection
export function isFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:";
  } catch {
    return false;
  }
}

export function normalizePdfUrl(url: string): string | null {
  if (!isPdfUrl(url)) {
    return null;
  }
  // Clean up any trailing query parameters or fragments for consistency
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
