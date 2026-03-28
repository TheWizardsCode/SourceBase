/**
 * CLI Progress Presenter Factory
 *
 * Factory function for creating appropriate progress presenters based on
 * environment and configuration.
 *
 * @module cli/presenters/factory
 * @example
 * ```typescript
 * // Create default presenter (Console in TTY, NDJSON otherwise)
 * const presenter = createProgressPresenter({});
 *
 * // Create specific presenter types
 * const ndjsonPresenter = createProgressPresenter({ format: "ndjson" });
 * const webhookPresenter = createProgressPresenter({ format: "webhook", webhookUrl: "..." });
 * ```
 */

import type {
  CliProgressPresenter,
  CliProgressPresenterOptions,
} from "./types.js";
import { NdjsonProgressPresenter } from "./ndjson-presenter.js";
import { ConsoleProgressPresenter } from "./console-presenter.js";
import { WebhookProgressPresenter } from "./webhook-presenter.js";

/**
 * Presenter format types
 */
export type PresenterFormat = "console" | "ndjson" | "webhook" | "auto";

/**
 * Extended options for creating presenters
 */
export interface CreateProgressPresenterOptions extends CliProgressPresenterOptions {
  /** Presenter format (default: "auto") */
  format?: PresenterFormat;
  /** Webhook URL (required for webhook format) */
  webhookUrl?: string;
  /** Output stream (default: process.stdout) */
  stdout?: NodeJS.WriteStream;
  /** Error stream (default: process.stderr) */
  stderr?: NodeJS.WriteStream;
}

/**
 * Check if stdout is a TTY (interactive terminal)
 */
function isTty(stdout: NodeJS.WriteStream = process.stdout): boolean {
  return stdout.isTTY ?? false;
}

/**
 * Create a progress presenter based on options and environment.
 *
 * Format selection:
 * - "console": Always use ConsoleProgressPresenter
 * - "ndjson": Always use NdjsonProgressPresenter
 * - "webhook": Use WebhookProgressPresenter (requires webhookUrl)
 * - "auto" (default): ConsoleProgressPresenter if TTY, NdjsonProgressPresenter otherwise
 *
 * @param options - Configuration options
 * @returns CliProgressPresenter instance
 * @throws Error if webhook format is requested without webhookUrl
 */
export function createProgressPresenter(
  options: CreateProgressPresenterOptions = {}
): CliProgressPresenter {
  const {
    format = "auto",
    stdout = process.stdout,
    stderr = process.stderr,
    webhookUrl,
    ...baseOptions
  } = options;

  switch (format) {
    case "console":
      return new ConsoleProgressPresenter(baseOptions, stdout, stderr);

    case "ndjson":
      return new NdjsonProgressPresenter(baseOptions, stdout, stderr);

    case "webhook":
      if (!webhookUrl) {
        throw new Error("webhookUrl is required when format is 'webhook'");
      }
      return new WebhookProgressPresenter(
        { ...baseOptions, webhookUrl },
        stderr
      );

    case "auto":
    default:
      // Default: Console in TTY mode, NDJSON otherwise
      if (isTty(stdout)) {
        return new ConsoleProgressPresenter(baseOptions, stdout, stderr);
      } else {
        return new NdjsonProgressPresenter(baseOptions, stdout, stderr);
      }
  }
}

/**
 * Get the default presenter format based on environment
 *
 * @param stdout - Output stream to check (default: process.stdout)
 * @returns "console" if TTY, "ndjson" otherwise
 */
export function getDefaultFormat(stdout: NodeJS.WriteStream = process.stdout): PresenterFormat {
  return isTty(stdout) ? "console" : "ndjson";
}
