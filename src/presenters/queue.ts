export function formatMissingCrawlSeedMessage(): string {
  return "Please pass a seed URL to crawl, for example: `crawl https://example.com`.";
}

export function formatQueuedUrlMessage(seed: string): string {
  return `Queued URL for crawling: \`${seed}\``;
}

export function formatQueueFailureMessage(error: string | undefined, fallbackError: string): string {
  return `Failed to queue URL\n\n${error || fallbackError}`;
}
