/**
 * CLI-compatible ProgressPresenter base interface
 * 
 * This module provides Discord-free base interfaces for progress presenters.
 * Discord-specific implementations extend these with Discord-specific options.
 * 
 * @module cli-progress-presenter
 * @example
 * ```typescript
 * // CLI implementation
 * class CliProgressPresenter extends CliProgressPresenterBase {
 *   async update(content: string): Promise<void> {
 *     console.log(content);
 *   }
 *   
 *   async clear(): Promise<void> {
 *     // No-op for CLI
 *   }
 *   
 *   async sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void> {
 *     console.log(this.format(update, overall));
 *   }
 * }
 * ```
 */

import type { 
  ProgressUpdate, 
  IngestionProgress, 
  ProgressPhase,
  Logger 
} from "./cli-types.js";

/**
 * Configuration options for CLI progress presenters
 * Discord-free base configuration
 */
export interface CliProgressPresenterOptions {
  /** Logger instance */
  logger: Logger;
  /** Maximum message length (e.g., console width) */
  maxMessageLength?: number;
  /** Whether to show chunk progress for large documents */
  showChunkProgress?: boolean;
}

/**
 * Result of a presenter operation
 */
export interface CliPresenterResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Interface for progress message presenters (Discord-free base)
 * 
 * Implementations handle the formatting, display, and cleanup of progress
 * messages during document ingestion. This abstraction allows for:
 * - Testing without Discord API calls
 * - Different presentation strategies (Discord, CLI, webhooks, etc.)
 * - Consistent message lifecycle management
 * 
 * @example
 * ```typescript
 * // Usage in ingestion service
 * class IngestionService {
 *   constructor(private readonly presenter: CliProgressPresenter) {}
 *   
 *   async processUrl(url: string): Promise<void> {
 *     // Update progress
 *     await this.presenter.update(
 *       this.presenter.format(
 *         { phase: "downloading", url, current: 1, total: 1 },
 *         { urls: [url], completed: 0, failed: 0, currentUrl: url, phase: "downloading" }
 *       )
 *     );
 *     
 *     // ... process ...
 *     
 *     // Clear when done
 *     await this.presenter.clear();
 *   }
 * }
 * ```
 */
export interface CliProgressPresenter {
  /**
   * Format a progress update into a display string
   * 
   * @param update - The individual progress update
   * @param overall - The overall batch progress state
   * @returns Formatted message string ready for display
   * 
   * @example
   * ```typescript
   * const content = presenter.format(
   *   { phase: "summarizing", url: "https://example.com", current: 1, total: 3 },
   *   { urls: ["https://example.com"], completed: 0, failed: 0, currentUrl: "https://example.com", phase: "summarizing" }
   * );
   * // Returns: "✍️ Summarizing: <https://example.com>"
   * ```
   */
  format(update: ProgressUpdate, overall: IngestionProgress): string;

  /**
   * Update or create the progress message
   * 
   * @param content - The formatted progress message content
   * @returns Promise resolving when the update is complete
   * 
   * @example
   * ```typescript
   * await presenter.update("⬇️ Downloading: <https://example.com>");
   * // Later...
   * await presenter.update("✍️ Summarizing: <https://example.com>");
   * ```
   */
  update(content: string): Promise<void>;

  /**
   * Clear/remove the progress message
   * 
   * @returns Promise resolving when cleanup is complete
   * 
   * @example
   * ```typescript
   * await presenter.clear();
   * ```
   */
  clear(): Promise<void>;

  /**
   * Send a final completion message
   * 
   * @param update - The final progress update (phase should be "completed" or "failed")
   * @param overall - The overall batch progress
   * @returns Promise resolving when the message is sent
   * 
   * @example
   * ```typescript
   * await presenter.clear();
   * await presenter.sendFinal(
   *   { phase: "completed", url: "https://example.com", current: 1, total: 1, title: "Article", summary: "..." },
   *   { urls: ["https://example.com"], completed: 1, failed: 0, currentUrl: null, phase: "completed" }
   * );
   * ```
   */
  sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void>;
}

/**
 * Factory for creating CLI progress presenters
 * 
 * @param options - Configuration options
 * @returns New CliProgressPresenter instance
 * 
 * @example
 * ```typescript
 * const presenter = createCliProgressPresenter({
 *   logger,
 *   maxMessageLength: 2000
 * });
 * ```
 */
export type CliProgressPresenterFactory = (options: CliProgressPresenterOptions) => CliProgressPresenter;

/**
 * Phase emoji mapping for visual indicators
 */
export const PHASE_EMOJI: Record<ProgressPhase, string> = {
  downloading: "⬇️",
  extracting_links: "🔗",
  updating: "🔄",
  summarizing: "✍️",
  embedding: "🔢",
  storing: "💾",
  completed: "✅",
  failed: "❌"
};

/**
 * Phase label mapping for human-readable text
 */
export const PHASE_LABEL: Record<ProgressPhase, string> = {
  downloading: "Downloading",
  extracting_links: "Extracting",
  updating: "Updating",
  summarizing: "Summarizing",
  embedding: "Embedding",
  storing: "Storing",
  completed: "Completed",
  failed: "Failed"
};

/**
 * Base class with common formatting utilities for CLI presenters
 * 
 * Extend this class to create custom progress presenters with
 * consistent formatting behavior.
 * 
 * @example
 * ```typescript
 * class CustomPresenter extends CliProgressPresenterBase {
 *   async update(content: string): Promise<void> {
 *     // Custom update logic
 *   }
 *   
 *   async clear(): Promise<void> {
 *     // Custom clear logic
 *   }
 *   
 *   async sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void> {
 *     // Custom final message logic
 *   }
 * }
 * ```
 */
export abstract class CliProgressPresenterBase implements CliProgressPresenter {
  protected readonly maxMessageLength: number;
  protected readonly showChunkProgress: boolean;

  constructor(options: CliProgressPresenterOptions) {
    this.maxMessageLength = options.maxMessageLength ?? 2000;
    this.showChunkProgress = options.showChunkProgress ?? true;
  }

  /**
   * Format a progress update into a display string
   */
  format(update: ProgressUpdate, overall: IngestionProgress): string {
    const emoji = PHASE_EMOJI[update.phase];
    const isMultiUrl = overall.urls.length > 1;
    const progressCounter = isMultiUrl ? `[${update.current}/${update.total}] ` : "";

    // For completed phase, show the summary instead of the URL
    if (update.phase === "completed" && update.summary) {
      const title = update.title || "Untitled";
      let summary = update.summary;
      
      // Truncate summary if needed to fit within message length limit
      const reservedSpace = 100;
      if (summary.length > this.maxMessageLength - reservedSpace - title.length) {
        summary = summary.slice(0, this.maxMessageLength - reservedSpace - title.length - 3) + "...";
      }
      
      return `${emoji} ${progressCounter}${title}\n\n${summary}`;
    }

    // For chunk-level progress (summarizing/embedding), show chunk info
    if (this.showChunkProgress && update.chunkCurrent && update.chunkTotal && 
        (update.phase === "summarizing" || update.phase === "embedding")) {
      const chunkInfo = ` (chunk ${update.chunkCurrent}/${update.chunkTotal})`;
      return `${emoji} ${progressCounter}${PHASE_LABEL[update.phase]}${chunkInfo}: <${update.url}>`;
    }

    let message = `${emoji} ${progressCounter}${PHASE_LABEL[update.phase]}: <${update.url}>`;

    if (update.phase === "failed" && update.message) {
      message += `\n   Error: ${update.message}`;
    }

    if (isMultiUrl && (update.phase === "completed" || update.phase === "failed")) {
      const completed = overall.completed;
      const failed = overall.failed;
      const total = overall.urls.length;
      message += `\n   Progress: ${completed} succeeded, ${failed} failed (${completed + failed}/${total})`;
    }

    // Final safety check - truncate if still too long
    if (message.length > this.maxMessageLength) {
      message = message.slice(0, this.maxMessageLength - 3) + "...";
    }

    return message;
  }

  abstract update(content: string): Promise<void>;
  abstract clear(): Promise<void>;
  abstract sendFinal(update: ProgressUpdate, overall: IngestionProgress): Promise<void>;
}
