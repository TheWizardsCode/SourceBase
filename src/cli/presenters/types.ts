/**
 * CLI Progress Presenter Types
 * 
 * Type definitions for CLI-native progress presenters that consume
 * the neutral event schema.
 * 
 * @module cli/presenters/types
 */

import type { ProgressUpdate, IngestionProgress, Logger, CliProgressEvent } from "../../interfaces/cli-types.js";

// Re-export CliProgressEvent from shared types
export type { CliProgressEvent };

/**
 * Options for creating CLI progress presenters
 */
export interface CliProgressPresenterOptions {
  /** Logger instance for error reporting */
  logger?: Logger;
  /** Webhook URL for WebhookProgressPresenter */
  webhookUrl?: string;
}

/**
 * Interface for CLI progress presenters
 * 
 * All presenters must implement this interface to handle
 * progress events from the ingestion service.
 */
export interface CliProgressPresenter {
  /**
   * Handle a progress event
   * 
   * @param event - The progress event to handle
   * @returns Promise resolving when the event has been processed
   */
  onProgress(event: CliProgressEvent): Promise<void>;
  
  /**
   * Clean up any resources
   * 
   * @returns Promise resolving when cleanup is complete
   */
  close?(): Promise<void>;
}

/**
 * Factory type for creating CLI progress presenters
 */
export type CliProgressPresenterFactory = (options: CliProgressPresenterOptions) => CliProgressPresenter;

/**
 * Convert internal progress types to neutral CliProgressEvent
 */
export function toCliProgressEvent(
  update: ProgressUpdate,
  overall: IngestionProgress
): CliProgressEvent {
  return {
    type: "progress",
    phase: update.phase,
    url: update.url,
    current: update.current,
    total: update.total,
    timestamp: new Date().toISOString(),
    message: update.message,
    summary: update.summary,
    title: update.title,
    chunkCurrent: update.chunkCurrent,
    chunkTotal: update.chunkTotal,
    chunkType: update.chunkType,
    isUpdate: update.isUpdate ?? overall.isUpdate
  };
}
