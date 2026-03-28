/**
 * Console Progress Presenter
 * 
 * Outputs human-friendly progress lines for interactive terminal use.
 * Uses emoji, phase labels, and progress counters for a rich CLI experience.
 * 
 * @module cli/presenters/console-presenter
 * @example
 * ```typescript
 * const presenter = new ConsoleProgressPresenter();
 * await presenter.onProgress({
 *   type: "progress",
 *   phase: "downloading",
 *   url: "https://example.com",
 *   current: 1,
 *   total: 3,
 *   timestamp: "2026-03-27T10:00:00.000Z"
 * });
 * // Output: ⬇️ [1/3] Downloading: https://example.com
 * ```
 */

import type {
  CliProgressPresenter,
  CliProgressEvent,
  CliProgressPresenterOptions,
} from "./types.js";

/**
 * Emoji mapping for progress phases
 */
const PHASE_EMOJI: Record<CliProgressEvent["phase"], string> = {
  downloading: "⬇️",
  extracting_links: "🔗",
  updating: "🔄",
  summarizing: "✍️",
  embedding: "🔢",
  storing: "💾",
  completed: "✅",
  failed: "❌",
};

/**
 * Human-readable labels for progress phases
 */
const PHASE_LABEL: Record<CliProgressEvent["phase"], string> = {
  downloading: "Downloading",
  extracting_links: "Extracting links",
  updating: "Updating",
  summarizing: "Summarizing",
  embedding: "Embedding",
  storing: "Storing",
  completed: "Completed",
  failed: "Failed",
};

/**
 * Progress presenter that outputs human-friendly lines to the console.
 *
 * Features:
 * - Emoji indicators for each phase
 * - Progress counters for batch operations
 * - Chunk progress for large documents
 * - Error details for failed operations
 * - TTY-aware output (carriage returns for in-progress, newlines for completed)
 */
export class ConsoleProgressPresenter implements CliProgressPresenter {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private lastLineLength = 0;

  constructor(
    _options: CliProgressPresenterOptions = {},
    stdout: NodeJS.WriteStream = process.stdout,
    stderr: NodeJS.WriteStream = process.stderr
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /**
   * Check if stdout is a TTY (interactive terminal)
   */
  private get isTty(): boolean {
    return this.stdout.isTTY ?? false;
  }

  /**
   * Clear the current line (for TTY mode)
   */
  private clearLine(): void {
    if (this.isTty && this.lastLineLength > 0) {
      // Move cursor to beginning of line and clear
      this.stdout.write("\r" + " ".repeat(this.lastLineLength) + "\r");
    }
  }

  /**
   * Format a progress event into a human-readable string
   */
  private format(event: CliProgressEvent): string {
    const emoji = PHASE_EMOJI[event.phase];
    const label = PHASE_LABEL[event.phase];

    // Build progress counter for batch operations
    const isMultiUrl = event.total > 1;
    const progressCounter = isMultiUrl ? `[${event.current}/${event.total}] ` : "";

    // For completed phase, show summary if available
    if (event.phase === "completed") {
      const title = event.title || "Untitled";

      if (event.summary) {
        // Truncate summary to reasonable length for console
        let summary = event.summary;
        const maxSummaryLength = 200;
        if (summary.length > maxSummaryLength) {
          summary = summary.slice(0, maxSummaryLength - 3) + "...";
        }
        return `${emoji} ${progressCounter}${title}\n${summary}`;
      }

      return `${emoji} ${progressCounter}${title}`;
    }

    // For failed phase, include error message
    if (event.phase === "failed") {
      let message = `${emoji} ${progressCounter}${label}`;
      if (event.message) {
        message += `\n   Error: ${event.message}`;
      }
      return message;
    }

    // For chunk-level progress, show chunk info
    if (
      event.chunkCurrent &&
      event.chunkTotal &&
      (event.phase === "summarizing" || event.phase === "embedding")
    ) {
      const chunkInfo = ` (chunk ${event.chunkCurrent}/${event.chunkTotal})`;
      return `${emoji} ${progressCounter}${label}${chunkInfo}: ${event.url}`;
    }

    // Standard phase display
    return `${emoji} ${progressCounter}${label}: ${event.url}`;
  }

  /**
   * Handle a progress event by writing formatted output to stdout
   *
   * @param event - The progress event to display
   */
  async onProgress(event: CliProgressEvent): Promise<void> {
    const formatted = this.format(event);

    return new Promise((resolve) => {
      // Clear previous line in TTY mode for in-progress phases
      if (this.isTty && event.phase !== "completed" && event.phase !== "failed") {
        this.clearLine();
      }

      // Determine output stream and line ending
      const isError = event.phase === "failed";
      const stream = isError ? this.stderr : this.stdout;
      const lineEnding =
        this.isTty && event.phase !== "completed" && event.phase !== "failed"
          ? ""
          : "\n";

      // Write the formatted message
      const output = formatted + lineEnding;
      this.lastLineLength =
        event.phase !== "completed" && event.phase !== "failed"
          ? formatted.length
          : 0;

      // Check if stream is writable
      if (!stream.writable) {
        resolve();
        return;
      }

      // Write the output
      stream.write(output, (err) => {
        if (err && isError) {
          // Already writing to stderr, can't log the error
        }
        resolve();
      });
    });
  }
}

/**
 * Factory function for creating console presenter instances
 *
 * @param options - Configuration options
 * @returns New ConsoleProgressPresenter instance
 */
export function createConsoleProgressPresenter(
  options: CliProgressPresenterOptions = {}
): ConsoleProgressPresenter {
  return new ConsoleProgressPresenter(options);
}
