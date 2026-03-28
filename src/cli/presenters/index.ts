/**
 * CLI Progress Presenters
 *
 * This module provides CLI-native progress presenters that consume the neutral
 * event schema. Three presenter implementations are available:
 *
 * - **NdjsonProgressPresenter**: Outputs one JSON line per event (for automation)
 * - **ConsoleProgressPresenter**: Human-friendly output for interactive terminals
 * - **WebhookProgressPresenter**: POSTs events to a webhook URL
 *
 * @module cli/presenters
 * @example
 * ```typescript
 * import {
 *   createProgressPresenter,
 *   NdjsonProgressPresenter,
 *   ConsoleProgressPresenter,
 *   WebhookProgressPresenter,
 *   toCliProgressEvent,
 *   type CliProgressEvent,
 *   type CliProgressPresenter
 * } from "./cli/presenters";
 *
 * // Use the factory to create appropriate presenter
 * const presenter = createProgressPresenter({ format: "auto" });
 *
 * // Convert internal progress to CLI event and display
 * const event = toCliProgressEvent(update, overall);
 * await presenter.onProgress(event);
 * ```
 */

// Types
export type {
  CliProgressEvent,
  CliProgressPresenter,
  CliProgressPresenterOptions,
  CliProgressPresenterFactory,
} from "./types.js";

export { toCliProgressEvent } from "./types.js";

// Presenter implementations
export {
  NdjsonProgressPresenter,
  createNdjsonProgressPresenter,
} from "./ndjson-presenter.js";

export {
  ConsoleProgressPresenter,
  createConsoleProgressPresenter,
} from "./console-presenter.js";

export {
  WebhookProgressPresenter,
  createWebhookProgressPresenter,
  type WebhookProgressPresenterOptions,
} from "./webhook-presenter.js";

// Factory
export {
  createProgressPresenter,
  getDefaultFormat,
  type CreateProgressPresenterOptions,
  type PresenterFormat,
} from "./factory.js";
