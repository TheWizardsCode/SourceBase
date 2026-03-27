/**
 * Discord Bot Interfaces
 * 
 * This module exports all interfaces and types used by the modular Discord bot
 * architecture. These interfaces define contracts that sibling refactoring work
 * items must conform to.
 * 
 * @module interfaces
 * @description Core interfaces for modular Discord bot architecture
 * 
 * @example
 * ```typescript
 * // Import all interfaces
 * import {
 *   CommandHandler,
 *   ProgressPresenter,
 *   QueuePresenter,
 *   LifecycleManager,
 *   ProgressUpdate,
 *   QueueItem,
 *   Logger
 * } from "./interfaces";
 * 
 * // Import specific modules
 * import type { CommandHandler, CommandResult } from "./interfaces/command-handler";
 * import { PHASE_EMOJI, PHASE_LABEL } from "./interfaces/progress-presenter";
 * ```
 * 
 * ## Sibling Work Item Guidelines
 * 
 * When implementing modules that use these interfaces:
 * 
 * 1. **Import from this module**, not from individual files:
 *    ```typescript
 *    // Good
 *    import { CommandHandler } from "../interfaces";
 *    
 *    // Avoid (may break if file structure changes)
 *    import { CommandHandler } from "../interfaces/command-handler.js";
 *    ```
 * 
 * 2. **Implement all required methods** of the interface
 * 
 * 3. **Use interface types for dependencies**, not concrete classes:
 *    ```typescript
 *    // Good
 *    constructor(private readonly presenter: ProgressPresenter) {}
 *    
 *    // Avoid
 *    constructor(private readonly presenter: DiscordProgressPresenter) {}
 *    ```
 * 
 * 4. **Document breaking changes** and update this file's version
 * 
 * 5. **Export your implementation** with a factory function:
 *    ```typescript
 *    export function createMyHandler(deps: MyHandlerDependencies): MyHandler {
 *      return new MyHandler(deps);
 *    }
 *    ```
 * 
 * ## Version History
 * 
 * - v1.0.0 (2026-03-26): Initial interface definitions
 *   - CommandHandler: Discord slash command processing
 *   - ProgressPresenter: Ingestion progress display
 *   - QueuePresenter: Queue status display
 *   - LifecycleManager: Bot startup/shutdown management
 *   - Shared types: Events, messages, callbacks
 *   - DI patterns: Factory functions, service locator
 */

// ============================================================================
// CLI-Compatible Types (Discord-free)
// ============================================================================

export type {
  // Progress event types
  ProgressPhase,
  ProgressUpdate,
  IngestionProgress,
  ProgressCallback,
  
  // Queue event types
  QueueUpdateStatus,
  CliQueueItem,
  PendingQueueItem,
  QueueUpdateCallback,
  
  // Crawl event types
  CrawlPhase,
  CrawlProgress,
  CrawlResult,
  CrawlProgressCallback,
  
  // Lifecycle event types
  RecoveryResult,
  ShutdownSignal,
  ShutdownOptions,
  
  // Utility types
  Result,
  AsyncInitializable,
  Disposable,
  Logger,
  SyntheticMessage,
} from "./cli-types.js";

// ============================================================================
// Discord-Specific Types
// ============================================================================

export type {
  // Discord message types
  MessageUrl,
  CommandContext,
  
  // Queue event types (Discord-specific)
  QueueItem,
} from "./types.js";

// ============================================================================
// Command Handler
// ============================================================================

export type {
  CommandResult,
  CommandHandler,
  CommandHandlerRegistry,
  CommandHandlerFactory,
} from "./command-handler.js";

export {
  findHandler,
  createCommandContext,
} from "./command-handler.js";

// ============================================================================
// CLI Progress Presenter (Discord-free base)
// ============================================================================

export type {
  CliProgressPresenterOptions,
  CliPresenterResult,
  CliProgressPresenter,
  CliProgressPresenterFactory,
} from "./cli-progress-presenter.js";

export {
  PHASE_EMOJI,
  PHASE_LABEL,
  CliProgressPresenterBase,
} from "./cli-progress-presenter.js";

// ============================================================================
// Discord Progress Presenter (extends CLI base)
// ============================================================================

export type {
  ProgressPresenterOptions,
  PresenterResult,
  ProgressPresenter,
  ProgressPresenterFactory,
} from "./progress-presenter.js";

export {
  ProgressPresenterBase,
} from "./progress-presenter.js";

// ============================================================================
// Queue Presenter
// ============================================================================

export type {
  QueuePresenterOptions,
  QueuePresenter,
  QueuePresenterFactory,
} from "./queue-presenter.js";

export {
  QUEUE_STATUS_EMOJI,
  QUEUE_STATUS_VERB,
  QUEUE_STATUS_PREPOSITION,
  QueuePresenterBase,
} from "./queue-presenter.js";

// ============================================================================
// Lifecycle Manager
// ============================================================================

export type {
  LifecycleManagerOptions,
  LifecycleResult,
  LifecycleManager,
  LifecycleManagerFactory,
  HealthCheckable,
  HealthStatus,
  HealthCheckResult,
} from "./lifecycle-manager.js";

// ============================================================================
// Dependency Injection Patterns
// ============================================================================

export type {
  ServiceLocator,
  ConfigProvider,
  ContextualProvider,
} from "./di-patterns.js";

export {
  SimpleServiceLocator,
} from "./di-patterns.js";
