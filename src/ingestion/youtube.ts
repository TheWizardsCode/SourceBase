import { config } from "../config.js";
import type { Logger } from "../logger.js";

export interface YouTubeVideoMetadata {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
}

interface YouTubeApiResponse {
  items: Array<{
    id: string;
    snippet: {
      title: string;
      description: string;
      thumbnails: {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
        standard?: { url: string };
        maxres?: { url: string };
      };
      channelTitle: string;
      publishedAt: string;
    };
  }>;
}

export class YouTubeApiClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://www.googleapis.com/youtube/v3";
  private readonly logger: Logger;

  constructor(logger: Logger, apiKey?: string) {
    this.apiKey = apiKey ?? config.YOUTUBE_API_KEY ?? "";
    this.logger = logger;
  }

  /**
   * Check if the client is properly configured with an API key
   */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Fetch video metadata from YouTube Data API v3
   * Implements exponential backoff for rate limiting
   */
  async fetchVideoMetadata(videoId: string): Promise<YouTubeVideoMetadata | null> {
    if (!this.isConfigured()) {
      this.logger.warn("YouTube API key not configured, skipping metadata fetch", { videoId });
      return null;
    }

    const url = new URL(`${this.baseUrl}/videos`);
    url.searchParams.append("part", "snippet");
    url.searchParams.append("id", videoId);
    url.searchParams.append("key", this.apiKey);

    let attempt = 0;
    const maxRetries = 3;
    let delay = 1000; // Start with 1 second

    while (attempt <= maxRetries) {
      try {
        this.logger.debug("Fetching YouTube video metadata", { videoId, attempt });

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        });

        if (response.status === 429) {
          // Rate limited - implement exponential backoff
          const retryAfter = response.headers.get("Retry-After");
          const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;

          this.logger.warn("YouTube API rate limited, backing off", {
            videoId,
            attempt,
            waitTime,
          });

          if (attempt < maxRetries) {
            await this.sleep(waitTime);
            delay *= 2; // Exponential backoff
            attempt++;
            continue;
          } else {
            this.logger.error("YouTube API rate limit exceeded after max retries", { videoId });
            return null;
          }
        }

        if (response.status === 403) {
          this.logger.error("YouTube API quota exceeded or invalid API key", { videoId });
          return null;
        }

        if (!response.ok) {
          this.logger.error("YouTube API request failed", {
            videoId,
            status: response.status,
            statusText: response.statusText,
          });
          return null;
        }

        const data: YouTubeApiResponse = await response.json();

        if (!data.items || data.items.length === 0) {
          this.logger.warn("YouTube video not found", { videoId });
          return null;
        }

        const video = data.items[0];
        const snippet = video.snippet;

        // Get best available thumbnail
        const thumbnails = snippet.thumbnails;
        const thumbnailUrl =
          thumbnails.maxres?.url ??
          thumbnails.standard?.url ??
          thumbnails.high?.url ??
          thumbnails.medium?.url ??
          thumbnails.default?.url ??
          "";

        return {
          videoId: video.id,
          title: snippet.title,
          description: snippet.description,
          thumbnailUrl,
          channelTitle: snippet.channelTitle,
          publishedAt: snippet.publishedAt,
        };
      } catch (error) {
        this.logger.error("Error fetching YouTube metadata", {
          videoId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt < maxRetries) {
          await this.sleep(delay);
          delay *= 2;
          attempt++;
          continue;
        }

        return null;
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
