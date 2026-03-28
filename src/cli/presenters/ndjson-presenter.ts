/**
 * NDJSON Progress Presenter
 * 
 * Outputs one JSON line per progress event to stdout.
 * This format is ideal for automation and programmatic consumption.
 * 
 * @module cli/presenters/ndjson-presenter
 * @example
 * ```typescript
 * const presenter = new NdjsonProgressPresenter();
 * await presenter.onProgress({
 *   type: "progress",
 *   phase: "downloading",
 *   url: "https://example.com",
 *   current: 1,
 *   total: 3,
 *   timestamp: "2026-03-27T10:00:00.000Z"
 * });
 * // Output: {"type":"progress","phase":"downloading","url":"https://example.com","current":1,"total":3,"timestamp":"2026-03-27T10:00:00.000Z"}
 * ```
 */

import type { CliProgressPresenter, CliProgressEvent, CliProgressPresenterOptions } from "./types.js";

/**
 * Progress presenter that outputs NDJSON (newline-delimited JSON) to stdout.
 * 
 * Each progress event is serialized as a single JSON line. This format is:
 * - Parseable by JSON.parse on each line
 * - Stream-friendly for real-time processing
 * - Compatible with tools like jq, ndjson-cli, etc.
 */
export class NdjsonProgressPresenter implements CliProgressPresenter {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;

  constructor(
    options: CliProgressPresenterOptions = {},
    stdout: NodeJS.WriteStream = process.stdout,
    stderr: NodeJS.WriteStream = process.stderr
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /**
   * Handle a progress event by writing it as JSON to stdout
   * 
   * @param event - The progress event to output
   */
  async onProgress(event: CliProgressEvent): Promise<void> {
    const jsonLine = JSON.stringify(event);
    
    return new Promise((resolve, reject) => {
      const output = jsonLine + "\n";
      
      // Check if stdout is writable
      if (!this.stdout.writable) {
        resolve();
        return;
      }
      
      // Write the JSON line
      const canContinue = this.stdout.write(output, (err) => {
        if (err) {
          // Log error to stderr but don't crash
          this.stderr.write(`Error writing progress: ${err.message}\n`);
        }
      });
      
      // If buffer is full, wait for drain event
      if (!canContinue) {
        this.stdout.once("drain", () => resolve());
      } else {
        resolve();
      }
    });
  }
}

/**
 * Factory function for creating NDJSON presenter instances
 * 
 * @param options - Configuration options
 * @returns New NdjsonProgressPresenter instance
 */
export function createNdjsonProgressPresenter(
  options: CliProgressPresenterOptions = {}
): NdjsonProgressPresenter {
  return new NdjsonProgressPresenter(options);
}
