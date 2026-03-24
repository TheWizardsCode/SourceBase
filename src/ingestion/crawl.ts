import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../logger.js";
import {
  extractCrawlSeedUrl,
  normalizeDiscoveredUrls,
  extractAnchorHrefsFromHtml,
} from "./url.js";
import { RobotsTxtCrawlPolicy } from "./crawlPolicy.js";

export interface CrawlProgress {
  phase: "starting" | "crawling" | "discovered" | "complete";
  url: string;
  discoveredCount: number;
  crawledCount: number;
}

export type CrawlProgressCallback = (progress: CrawlProgress) => void | Promise<void>;

export interface CrawlOptions {
  logger: Logger;
  maxUrls?: number;
  maxDepth?: number;
  userAgent?: string;
  requestDelayMs?: number;
  onProgress?: CrawlProgressCallback;
}

export interface CrawlResult {
  seedUrl: string;
  discoveredUrls: string[];
  crawledCount: number;
  skippedCount: number;
  errors: Array<{ url: string; error: string }>;
}

export class CrawlService {
  private readonly crawlPolicy: RobotsTxtCrawlPolicy;
  private readonly maxUrls: number;
  private readonly maxDepth: number;
  private readonly userAgent: string;
  private readonly requestDelayMs: number;

  constructor(private readonly options: CrawlOptions) {
    this.maxUrls = options.maxUrls ?? 50;
    this.maxDepth = options.maxDepth ?? 2;
    // Default to a common, well-known browser user agent string unless overridden.
    this.userAgent = options.userAgent ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36";
    this.requestDelayMs = options.requestDelayMs ?? 1000;
    this.crawlPolicy = new RobotsTxtCrawlPolicy({
      userAgent: this.userAgent,
      fallbackDelayMs: this.requestDelayMs,
      logger: options.logger,
    });
  }

  /**
   * Check if a message contains a crawl command
   */
  isCrawlCommand(content: string): boolean {
    return extractCrawlSeedUrl(content) !== null;
  }

  /**
   * Execute a crawl from a Discord message
   */
  async crawlFromMessage(content: string): Promise<CrawlResult | null> {
    const seedUrl = extractCrawlSeedUrl(content);
    if (!seedUrl) {
      return null;
    }

    return this.crawl(seedUrl);
  }

  /**
   * Crawl starting from a seed URL
   */
  async crawl(seedUrl: string): Promise<CrawlResult> {
    const result: CrawlResult = {
      seedUrl,
      discoveredUrls: [],
      crawledCount: 0,
      skippedCount: 0,
      errors: [],
    };

    const visitedUrls = new Set<string>();
    const urlsToCrawl: Array<{ url: string; depth: number }> = [
      { url: seedUrl, depth: 0 },
    ];

    this.options.logger.info("Starting crawl", {
      seedUrl,
      maxUrls: this.maxUrls,
      maxDepth: this.maxDepth,
    });

    while (urlsToCrawl.length > 0 && result.discoveredUrls.length < this.maxUrls) {
      const { url, depth } = urlsToCrawl.shift()!;

      // Skip if already visited
      if (visitedUrls.has(url)) {
        continue;
      }
      visitedUrls.add(url);

      // Report progress - crawling this URL
      if (this.options.onProgress) {
        await this.options.onProgress({
          phase: "crawling",
          url,
          discoveredCount: result.discoveredUrls.length,
          crawledCount: result.crawledCount,
        });
      }

      // Check robots.txt
      try {
        const canFetch = await this.crawlPolicy.canFetch(url);
        if (!canFetch) {
          this.options.logger.info("Crawl disallowed by robots.txt", { url });
          result.skippedCount++;
          continue;
        }

        // Wait before fetching (respect crawl-delay)
        await this.crawlPolicy.waitBeforeFetch(url);

        // Fetch the URL
        this.options.logger.info("Crawling URL", { url, depth });
        const response = await fetch(url, {
          headers: {
            "User-Agent": this.userAgent,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          this.options.logger.debug("Skipping non-HTML content", {
            url,
            contentType,
          });
          continue;
        }

        const html = await response.text();
        result.crawledCount++;

        // Add the URL to discovered list (except the seed URL itself)
        if (url !== seedUrl) {
          result.discoveredUrls.push(url);

          // Report progress - discovered a new URL
          if (this.options.onProgress) {
            await this.options.onProgress({
              phase: "discovered",
              url,
              discoveredCount: result.discoveredUrls.length,
              crawledCount: result.crawledCount,
            });
          }
        }

        // Extract and queue links if we haven't reached max depth
        if (depth < this.maxDepth) {
          const links = extractAnchorHrefsFromHtml(html);
          const normalizedLinks = normalizeDiscoveredUrls(url, links);

          this.options.logger.debug("Discovered links", {
            url,
            linkCount: normalizedLinks.length,
          });

          // Add new links to crawl queue
          for (const link of normalizedLinks) {
            if (!visitedUrls.has(link) && result.discoveredUrls.length < this.maxUrls) {
              urlsToCrawl.push({ url: link, depth: depth + 1 });
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("Failed to crawl URL", { url, error: errorMessage });
        result.errors.push({ url, error: errorMessage });
      }
    }

    // Report progress - complete
    if (this.options.onProgress) {
      await this.options.onProgress({
        phase: "complete",
        url: seedUrl,
        discoveredCount: result.discoveredUrls.length,
        crawledCount: result.crawledCount,
      });
    }

    this.options.logger.info("Crawl complete", {
      seedUrl,
      discoveredCount: result.discoveredUrls.length,
      crawledCount: result.crawledCount,
      skippedCount: result.skippedCount,
      errorCount: result.errors.length,
    });

    return result;
  }
}
