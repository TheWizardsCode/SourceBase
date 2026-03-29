/**
 * CLI-compatible types with zero Discord dependencies
 * 
 * This module provides common types used across both CLI and bot modules.
 * These types have no dependencies on discord.js and can be safely imported
 * from CLI code.
 * 
 * @module cli-types
 * @description Core type definitions for CLI and shared bot functionality
 */

// ============================================================================
// Progress Event Types
// ============================================================================

/**
 * Phase of document ingestion process
 * - downloading: Fetching content from URL
 * - extracting_links: Extracting related links from content
 * - updating: Checking if document already exists
 * - summarizing: Generating content summary
 * - embedding: Creating vector embeddings
 * - storing: Persisting to database
 * - completed: Successfully processed
 * - failed: Error during processing
 */
export type ProgressPhase = 
  | "downloading"
  | "extracting_links"
  | "updating"
  | "summarizing"
  | "embedding"
  | "storing"
  | "completed"
  | "failed";

/**
 * Individual progress update for a single URL
 * @example
 * ```typescript
 * const progressUpdate: ProgressUpdate = {
 *   phase: "summarizing",
 *   url: "https://example.com/article",
 *   current: 1,
 *   total: 3,
 *   chunkCurrent: 2,
 *   chunkTotal: 5,
 *   title: "Example Article"
 * };
 * ```
 */
export interface ProgressUpdate {
  /** Current processing phase */
  phase: ProgressPhase;
  /** URL being processed */
  url: string;
  /** Current item number in batch */
  current: number;
  /** Total items in batch */
  total: number;
  /** Optional error message for failed phase */
  message?: string;
  /** Generated summary (available in completed phase) */
  summary?: string;
  /** Document title (available in completed phase) */
  title?: string;
  /** Current queue size */
  queueSize?: number;
  /** Whether this is an update to existing document */
  isUpdate?: boolean;
  /** Current chunk number (for chunked operations) */
  chunkCurrent?: number;
  /** Total chunks (for chunked operations) */
  chunkTotal?: number;
  /** Type of chunking operation */
  chunkType?: "summarizing" | "embedding";
}

/**
 * Overall progress state for a batch of URLs
 * @example
 * ```typescript
 * const overallProgress: IngestionProgress = {
 *   urls: ["https://example.com/1", "https://example.com/2"],
 *   completed: 1,
 *   failed: 0,
 *   currentUrl: "https://example.com/2",
 *   phase: "embedding"
 * };
 * ```
 */
export interface IngestionProgress {
  /** All URLs being processed */
  urls: string[];
  /** Number of successfully completed URLs */
  completed: number;
  /** Number of failed URLs */
  failed: number;
  /** Currently processing URL (null if idle) */
  currentUrl: string | null;
  /** Current phase of the batch */
  phase: ProgressPhase;
  /** Associated Discord message ID (optional, for bot use) */
  messageId?: string;
  /** Current queue size */
  queueSize?: number;
  /** Whether batch contains updates */
  isUpdate?: boolean;
}

/**
 * Callback function type for progress updates
 */
export type ProgressCallback = (
  update: ProgressUpdate,
  overall: IngestionProgress,
  messageId?: string
) => void | Promise<void>;

// ============================================================================
// Queue Event Types
// ============================================================================

/**
 * Status of a queue update event
 * - added: Item added to queue
 * - processing: Item is being processed
 * - skipped: Item skipped (duplicate or invalid)
 */
export type QueueUpdateStatus = 'added' | 'processing' | 'skipped';

/**
 * CLI-compatible queue item with plain string IDs
 * This is a Discord-free variant for CLI use
 * @example
 * ```typescript
 * const queueItem: CliQueueItem = {
 *   url: "https://example.com/article",
 *   messageId: "123456789",
 *   channelId: "987654321",
 *   authorId: "111222333",
 *   dbId: 123
 * };
 * ```
 */
export interface CliQueueItem {
  /** URL to process */
  url: string;
  /** Discord message ID (or synthetic ID for CLI) */
  messageId: string;
  /** Discord channel ID (or "cli" for CLI usage) */
  channelId: string;
  /** Discord author ID (or "cli-user" for CLI usage) */
  authorId: string;
  /** Database ID if persisted */
  dbId?: number;
  /** Message content (typically the URL) */
  content?: string;
}

/**
 * Queue item loaded from database (pending items)
 * @example
 * ```typescript
 * const pendingItem: PendingQueueItem = {
 *   url: "https://example.com",
 *   sourceId: "123456",
 *   sourceContext: "789012",
 *   authorId: "345678",
 *   dbId: 42
 * };
 * ```
 */
export interface PendingQueueItem {
  /** URL to process */
  url: string;
  /** Source ID (Discord message ID or CLI-generated ID) */
  sourceId: string;
  /** Source context (Discord channel ID or "cli") */
  sourceContext: string;
  /** Author ID (Discord user ID or CLI user) */
  authorId: string;
  /** Database record ID */
  dbId: number;
}

/**
 * Callback function type for queue updates
 */
export type QueueUpdateCallback = (
  item: CliQueueItem,
  queueSize: number,
  status: QueueUpdateStatus
) => Promise<void> | void;

// ============================================================================
// Crawl Event Types
// ============================================================================

/**
 * Phase of URL crawling process
 * - starting: Initializing crawl
 * - crawling: Fetching a URL
 * - discovered: Found new URL
 * - complete: Crawl finished
 */
export type CrawlPhase = "starting" | "crawling" | "discovered" | "complete";

/**
 * Progress update during URL crawling
 * @example
 * ```typescript
 * const crawlProgress: CrawlProgress = {
 *   phase: "discovered",
 *   url: "https://example.com/page2",
 *   discoveredCount: 5,
 *   crawledCount: 3
 * };
 * ```
 */
export interface CrawlProgress {
  /** Current crawl phase */
  phase: CrawlPhase;
  /** URL being crawled or discovered */
  url: string;
  /** Number of URLs discovered so far */
  discoveredCount: number;
  /** Number of URLs crawled so far */
  crawledCount: number;
}

/**
 * Result of a crawl operation
 * @example
 * ```typescript
 * const crawlResult: CrawlResult = {
 *   seedUrl: "https://example.com",
 *   discoveredUrls: ["https://example.com/page1", "https://example.com/page2"],
 *   crawledCount: 3,
 *   skippedCount: 0,
 *   errors: []
 * };
 * ```
 */
export interface CrawlResult {
  /** Initial seed URL */
  seedUrl: string;
  /** All discovered URLs */
  discoveredUrls: string[];
  /** Number of URLs successfully crawled */
  crawledCount: number;
  /** Number of URLs skipped (e.g., robots.txt disallowed) */
  skippedCount: number;
  /** Errors encountered during crawling */
  errors: Array<{ url: string; error: string }>;
}

/**
 * Callback function type for crawl progress updates
 */
export type CrawlProgressCallback = (progress: CrawlProgress) => void | Promise<void>;

// ============================================================================
// Lifecycle Event Types
// ============================================================================

/**
 * Result of startup recovery operation
 * @example
 * ```typescript
 * const recoveryResult: RecoveryResult = {
 *   messagesProcessed: 10,
 *   messagesSkipped: { botMessages: 2, noUrls: 1, total: 3 },
 *   urlsFound: 5,
 *   urlsQueued: 5,
 *   oldestMessageId: "123",
 *   newestMessageId: "456"
 * };
 * ```
 */
export interface RecoveryResult {
  /** Number of messages processed during recovery */
  messagesProcessed: number;
  /** Breakdown of skipped messages */
  messagesSkipped: {
    botMessages: number;
    noUrls: number;
    total: number;
  };
  /** Number of URLs found in messages */
  urlsFound: number;
  /** Number of URLs successfully queued */
  urlsQueued: number;
  /** Oldest message ID processed */
  oldestMessageId: string | null;
  /** Newest message ID processed */
  newestMessageId: string | null;
}

/**
 * Shutdown signal types
 */
export type ShutdownSignal = "SIGTERM" | "SIGINT";

/**
 * Options for graceful shutdown
 */
export interface ShutdownOptions {
  /** Signal that triggered shutdown */
  signal: ShutdownSignal;
  /** Whether this is a forced shutdown */
  force?: boolean;
  /** Timeout in milliseconds before forcing exit */
  timeoutMs?: number;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Generic result type for operations that may fail
 */
export interface Result<T, E = Error> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Result data (if successful) */
  data?: T;
  /** Error information (if failed) */
  error?: E;
}

/**
 * Async initializer interface for services requiring async setup
 */
export interface AsyncInitializable {
  /** Initialize the service */
  initialize(): Promise<void>;
}

/**
 * Disposable interface for resources requiring cleanup
 */
export interface Disposable {
  /** Clean up resources */
  dispose(): Promise<void>;
}

/**
 * Logger interface abstraction for dependency injection
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private readonly logger: Logger) {}
 *   
 *   doSomething() {
 *     this.logger.info("Doing something");
 *   }
 * }
 * ```
 */
export interface Logger {
  /** Log debug message */
  debug(message: string, meta?: Record<string, unknown>): void;
  /** Log informational message */
  info(message: string, meta?: Record<string, unknown>): void;
  /** Log warning message */
  warn(message: string, meta?: Record<string, unknown>): void;
  /** Log error message */
  error(message: string, meta?: Record<string, unknown>): void;
}

// ============================================================================
// Synthetic Message Types (Discord-free)
// ============================================================================

/**
 * Synthetic message representation for items loaded from database
 * Used when restoring queue state after bot restart or for CLI mock messages
 * @example
 * ```typescript
 * const syntheticMessage = createSyntheticMessage({
 *   id: "123456789",
 *   channelId: "987654321",
 *   authorId: "111222333",
 *   content: "https://example.com"
 * });
 * ```
 */
export interface SyntheticMessage {
  /** Discord message ID */
  id: string;
  /** Discord channel ID */
  channelId: string;
  /** Discord author ID */
  authorId: string;
  /** Message content (typically the URL) */
  content: string;
  /** Optional: Discord client for bot reactions (bot only) */
  client?: {
    user?: {
      id: string;
    } | null;
  };
  /** Optional: Discord reactions for bot use */
  reactions?: {
    cache: {
      get: (key: string) => { users: { remove: (userId: string) => Promise<void> } } | undefined;
    };
    resolve: (key: string) => { users: { remove: (userId: string) => Promise<void> } } | undefined;
  };
  /** Optional: React function for bot use */
  react?: (emoji: string) => Promise<void>;
}

// ============================================================================
// CLI Progress Event Types
// ============================================================================

/**
 * CLI Progress Event - Neutral schema for progress updates
 * Used by CLI presenters and consumed by bot for Discord message updates
 * 
 * This type is shared between CLI and bot to enable subprocess communication
 * via NDJSON without creating a circular dependency.
 * 
 * @example
 * ```typescript
 * const event: CliProgressEvent = {
 *   type: "progress",
 *   phase: "summarizing",
 *   url: "https://example.com",
 *   current: 1,
 *   total: 1,
 *   timestamp: "2026-03-29T12:00:00.000Z",
 *   chunkCurrent: 2,
 *   chunkTotal: 5
 * };
 * ```
 */
export interface CliProgressEvent {
  /** Event type identifier */
  type: "progress";
  /** Current processing phase */
  phase: ProgressPhase;
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
