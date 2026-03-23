const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;

// YouTube URL patterns with word boundaries to ensure exact 11-char match
// Note: The 'i' flag makes domain matching case-insensitive, but video ID case is preserved
const YOUTUBE_PATTERNS = {
  // Standard watch URLs: youtube.com/watch?v=VIDEO_ID
  standard: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i,
  
  // Short URLs: youtu.be/VIDEO_ID
  short: /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})\b/i,
  
  // Shorts URLs: youtube.com/shorts/VIDEO_ID
  shorts: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})\b/i,
  
  // Embed URLs: youtube.com/embed/VIDEO_ID
  embed: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})\b/i,
  
  // Live URLs: youtube.com/live/VIDEO_ID
  live: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})\b/i,
  
  // Mobile app URLs (m.youtube.com): m.youtube.com/watch?v=VIDEO_ID
  mobile: /(?:https?:\/\/)?m\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i,
  
  // Music URLs: music.youtube.com/watch?v=VIDEO_ID
  music: /(?:https?:\/\/)?music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})\b/i
};

// Video ID validation: 11 characters, alphanumeric plus _ and -
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const normalized = matches.map((raw) => raw.replace(/[),.;!?]+$/g, ""));
  return Array.from(new Set(normalized));
}

/**
 * Check if a URL is a YouTube video URL
 * Supports: youtube.com/watch, youtu.be, youtube.com/shorts, youtube.com/embed,
 * youtube.com/live, m.youtube.com, music.youtube.com
 */
export function isYouTubeUrl(url: string): boolean {
  return Object.values(YOUTUBE_PATTERNS).some(pattern => pattern.test(url));
}

/**
 * Extract the canonical 11-character video ID from a YouTube URL
 * Returns null if the URL is not a valid YouTube video URL
 */
export function extractYouTubeVideoId(url: string): string | null {
  for (const pattern of Object.values(YOUTUBE_PATTERNS)) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      // Validate video ID format
      if (VIDEO_ID_REGEX.test(videoId)) {
        return videoId;
      }
    }
  }
  return null;
}

/**
 * Normalize a YouTube URL to a canonical format
 * Returns the standard watch URL with just the video ID
 */
export function normalizeYouTubeUrl(url: string): string | null {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Extract anchor hrefs from HTML content
 * Used for crawling linked pages
 */
export function extractAnchorHrefsFromHtml(html: string): string[] {
  const hrefRegex = /href="([^"]+)"/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1] && !match[1].startsWith('#') && !match[1].startsWith('javascript:')) {
      matches.push(match[1]);
    }
  }
  return matches;
}

/**
 * Extract crawl seed URL from message text
 * Looks for special crawl commands
 */
export function extractCrawlSeedUrl(text: string): string | null {
  // Check for crawl command pattern: /crawl <url>
  const crawlMatch = text.match(/\/crawl\s+(https?:\/\/[^\s]+)/i);
  if (crawlMatch) {
    return crawlMatch[1];
  }
  return null;
}

/**
 * Normalize discovered URLs relative to a base URL
 */
export function normalizeDiscoveredUrls(baseUrl: string, urls: string[]): string[] {
  const normalized = new Set<string>();
  const base = new URL(baseUrl);

  for (const url of urls) {
    try {
      const absolute = new URL(url, base).href;
      // Only include same-origin URLs
      if (absolute.startsWith(base.origin)) {
        normalized.add(absolute);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(normalized);
}
