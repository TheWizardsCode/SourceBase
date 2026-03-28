/**
 * Webhook Progress Presenter
 *
 * POSTs JSON progress events to a provided webhook URL.
 * Features automatic retry on network errors and logs errors to stderr.
 *
 * @module cli/presenters/webhook-presenter
 * @example
 * ```typescript
 * const presenter = new WebhookProgressPresenter({ webhookUrl: "https://example.com/webhook" });
 * await presenter.onProgress({
 *   type: "progress",
 *   phase: "downloading",
 *   url: "https://example.com",
 *   current: 1,
 *   total: 3,
 *   timestamp: "2026-03-27T10:00:00.000Z"
 * });
 * // POSTs JSON payload to webhook URL
 * ```
 */

import type {
  CliProgressPresenter,
  CliProgressEvent,
  CliProgressPresenterOptions,
} from "./types.js";

/**
 * Extended options for webhook presenter
 */
export interface WebhookProgressPresenterOptions extends CliProgressPresenterOptions {
  /** Webhook URL to POST events to */
  webhookUrl: string;
  /** Maximum number of retries (default: 1) */
  maxRetries?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

/**
 * Progress presenter that POSTs events to a webhook URL.
 *
 * Features:
 * - Unauthenticated POST requests
 * - Automatic retry once on network errors
 * - Logs errors to stderr (does not crash)
 * - Configurable timeout
 */
export class WebhookProgressPresenter implements CliProgressPresenter {
  private readonly webhookUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly stderr: NodeJS.WriteStream;

  constructor(
    options: WebhookProgressPresenterOptions,
    stderr: NodeJS.WriteStream = process.stderr
  ) {
    if (!options.webhookUrl) {
      throw new Error("webhookUrl is required");
    }
    this.webhookUrl = options.webhookUrl;
    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.stderr = stderr;
  }

  /**
   * Log error to stderr
   */
  private logError(message: string): void {
    if (this.stderr.writable) {
      this.stderr.write(`[WebhookProgressPresenter] ${message}\n`);
    }
  }

  /**
   * Make a POST request with timeout and retry logic
   */
  private async postWithRetry(payload: object): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Consider 2xx status codes as success
        if (response.ok) {
          return;
        }

        // Non-2xx response is not retryable
        const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
        this.logError(`Webhook failed: ${errorMsg}`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on network errors (not on HTTP errors)
        if (attempt < this.maxRetries) {
          // Wait a bit before retrying (exponential backoff)
          await this.delay(1000 * Math.pow(2, attempt));
        }
      }
    }

    // All retries exhausted
    this.logError(
      `Webhook unreachable after ${this.maxRetries + 1} attempts: ${lastError?.message}`
    );
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Handle a progress event by POSTing it to the webhook URL
   *
   * @param event - The progress event to send
   */
  async onProgress(event: CliProgressEvent): Promise<void> {
    try {
      await this.postWithRetry(event);
    } catch (error) {
      // Log error but don't crash
      const message = error instanceof Error ? error.message : String(error);
      this.logError(`Failed to send progress: ${message}`);
    }
  }

  /**
   * No cleanup needed for webhook presenter
   */
  async close(): Promise<void> {
    // No resources to clean up
  }
}

/**
 * Factory function for creating webhook presenter instances
 *
 * @param options - Configuration options (must include webhookUrl)
 * @returns New WebhookProgressPresenter instance
 * @throws Error if webhookUrl is not provided
 */
export function createWebhookProgressPresenter(
  options: WebhookProgressPresenterOptions
): WebhookProgressPresenter {
  return new WebhookProgressPresenter(options);
}
