/**
 * Shared types for Discord bot interfaces
 * 
 * This module provides common types used across all bot modules including
 * message types, progress events, queue events, and crawl events.
 * 
 * Discord-specific types remain in this module. Shared CLI-compatible types
 * are re-exported from cli-types.ts for backward compatibility.
 * 
 * @module types
 * @description Core type definitions for modular Discord bot architecture
 */

import type { Message, CommandInteraction, TextChannel } from "discord.js";

// Re-export all CLI-compatible types for backward compatibility
export type {
  ProgressPhase,
  ProgressUpdate,
  IngestionProgress,
  ProgressCallback,
  QueueUpdateStatus,
  CliQueueItem,
  PendingQueueItem,
  QueueUpdateCallback,
  CrawlPhase,
  CrawlProgress,
  CrawlResult,
  CrawlProgressCallback,
  RecoveryResult,
  ShutdownSignal,
  ShutdownOptions,
  Result,
  AsyncInitializable,
  Disposable,
  Logger,
  SyntheticMessage,
} from "./cli-types.js";

// Re-export CLI-compatible values/interfaces
export {
  // All types are re-exported above
} from "./cli-types.js";

// ============================================================================
// Discord Message Types
// ============================================================================

/**
 * Represents a URL extracted from a Discord message with metadata
 * @example
 * ```typescript
 * const messageUrl: MessageUrl = {
 *   url: "https://example.com/article",
 *   message: discordMessage,
 *   extractedAt: new Date()
 * };
 * ```
 */
export interface MessageUrl {
  /** The extracted URL string */
  url: string;
  /** The Discord message containing the URL */
  message: Message;
  /** Timestamp when the URL was extracted */
  extractedAt: Date;
}

/**
 * Context for command handlers providing access to Discord entities
 * @example
 * ```typescript
 * const context: CommandContext = {
 *   interaction,
 *   channel: interaction.channel as TextChannel,
 *   client: discordClient
 * };
 * ```
 */
export interface CommandContext {
  /** The Discord command interaction */
  interaction: CommandInteraction;
  /** The text channel where the command was issued */
  channel: TextChannel;
  /** The Discord client instance */
  client: { user: { id: string } | null };
}

// ============================================================================
// Queue Event Types (Discord-specific)
// ============================================================================

/**
 * Item in the document processing queue with Discord Message object
 * This is the Discord-specific variant that includes the full Message object
 * @example
 * ```typescript
 * const queueItem: QueueItem = {
 *   message: discordMessage,
 *   url: "https://example.com/article",
 *   dbId: 123
 * };
 * ```
 */
export interface QueueItem {
  /** Discord message associated with this item */
  message: Message;
  /** URL to process */
  url: string;
  /** Database ID if persisted */
  dbId?: number;
}
