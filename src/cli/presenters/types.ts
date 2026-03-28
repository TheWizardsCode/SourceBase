/**
 * CLI Progress Presenter Types
 * 
 * Type definitions for CLI-native progress presenters that consume
 * the neutral event schema.
 * 
 * @module cli/presenters/types
 */

import type { ProgressUpdate, IngestionProgress, Logger } from "../../interfaces/cli-types.js";

/**
 * CLI Progress Event - Neutral schema for progress updates
 * Used by all CLI presenters
 */
export interface CliProgressEvent {
  /** Event type identifier */
  type: "progress";
  /** Current processing phase */
  phase: ProgressUpdate["phase"];
  /** URL being processed */
  url: string;
  /** Current item number in batch */
  current: number;
  /** Total items in batch */
  total: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional error message for failed phase */
  message?: string;
  /** Generated summary (available in completed phase) */
  summary?: string;
  /** Document title (available in completed phase) */
  title?: string;
  /** Current chunk number (for chunked operations) */
  chunkCurrent?: number;
  /** Total chunks (for chunked operations) */
  chunkTotal?: number;
  /** Type of chunking operation */
  chunkType?: "summarizing" | "embedding";
  /** Whether this is an update to existing document */
  isUpdate?: boolean;
}

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
