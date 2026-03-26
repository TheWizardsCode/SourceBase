/**
 * Dependency Injection Patterns
 * 
 * This module documents the dependency injection (DI) patterns used throughout
 * the modular Discord bot architecture. These patterns enable testability,
 * flexibility, and loose coupling between components.
 * 
 * @module di-patterns
 * @description Dependency injection patterns and factory functions
 * 
 * ## Overview
 * 
 * The bot uses constructor injection as its primary DI pattern. Services and
 * handlers receive their dependencies through constructor parameters, making
 * dependencies explicit and enabling easy mocking for testing.
 * 
 * ## Pattern 1: Constructor Injection
 * 
 * The most common pattern - dependencies are passed to the constructor.
 * 
 * ```typescript
 * class CrawlCommandHandler implements CommandHandler {
 *   constructor(
 *     private readonly crawlService: CrawlService,
 *     private readonly documentQueue: DocumentQueue,
 *     private readonly logger: Logger
 *   ) {}
 *   
 *   async handle(context: CommandContext): Promise<CommandResult> {
 *     // Use this.crawlService, this.documentQueue, this.logger
 *   }
 * }
 * ```
 * 
 * ## Pattern 2: Interface-Based Dependencies
 * 
 * Depend on interfaces, not concrete implementations, for maximum flexibility.
 * 
 * ```typescript
 * // Good: Depends on interface
 * class IngestionService {
 *   constructor(
 *     private readonly presenter: ProgressPresenter,  // Interface
 *     private readonly repository: LinkStore          // Interface
 *   ) {}
 * }
 * 
 * // Less flexible: Depends on concrete class
 * class IngestionService {
 *   constructor(
 *     private readonly presenter: DiscordProgressPresenter,  // Concrete
 *     private readonly repository: LinkRepository            // Concrete
 *   ) {}
 * }
 * ```
 * 
 * ## Pattern 3: Factory Functions
 * 
 * Use factory functions for complex object creation or when conditional
 * instantiation is needed.
 * 
 * ```typescript
 * // Factory type definition
 * export type ProgressPresenterFactory = (options: ProgressPresenterOptions) => ProgressPresenter;

// Factory implementation
export function createProgressPresenter(options: ProgressPresenterOptions): ProgressPresenter {
  return new DiscordProgressPresenter(options);
}

// Usage in composition root
const presenter = createProgressPresenter({ channel, logger });
```

## Pattern 4: Composition Root

Centralize all dependency wiring in a single composition root (typically
`src/index.ts` or `src/composition.ts`).

```typescript
// composition.ts
export function createBot(): DiscordBot {
  // Infrastructure
  const logger = new Logger(config.LOG_LEVEL);
  const dbPool = getDbPool();
  
  // Repositories
  const repository = new LinkRepository(dbPool);
  const queueRepository = new DocumentQueueRepository(dbPool);
  
  // Services
  const llmClient = new OpenAiCompatibleLlmClient(config);
  const embeddingProvider = new OpenAiCompatibleEmbeddingProvider(llmClient);
  const crawlService = new CrawlService({ logger });
  
  // Presenters (created per-use)
  const createProgressPresenter = (channel: TextChannel) => 
    new DiscordProgressPresenter({ channel, logger });
  
  // Queue
  const documentQueue = new DocumentQueue({
    logger,
    ingestionService,
    repository: queueRepository,
    onQueueUpdate: async (item, size, status) => {
      const presenter = createQueuePresenter(item.message.channel as TextChannel);
      await presenter.update(item.message.channelId, presenter.format(item.url, size, status));
    }
  });
  
  // Command handlers
  const handlers: CommandHandler[] = [
    new StatsCommandHandler(repository, queueRepository),
    new CrawlCommandHandler(crawlService, documentQueue, logger)
  ];
  
  // Bot
  return new DiscordBot({
    token: config.DISCORD_BOT_TOKEN,
    monitoredChannelId: config.DISCORD_CHANNEL_ID,
    logger,
    onInteraction: createInteractionHandler(handlers, logger)
  });
}
```

## Pattern 5: Optional Dependencies with Defaults

Use options objects with defaults for optional dependencies.

```typescript
interface ServiceOptions {
  logger?: Logger;  // Optional
  timeoutMs?: number;  // Optional with default
}

class MyService {
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  
  constructor(options: ServiceOptions = {}) {
    this.logger = options.logger ?? new ConsoleLogger();
    this.timeoutMs = options.timeoutMs ?? 5000;
  }
}
```

## Pattern 6: Provider Pattern for Context-Specific Dependencies

Use a provider function when dependencies depend on runtime context.

```typescript
class IngestionService {
  constructor(
    private readonly presenterProvider: (channel: TextChannel) => ProgressPresenter,
    private readonly logger: Logger
  ) {}
  
  async processMessage(message: Message): Promise<void> {
    // Get presenter for this specific message's channel
    const presenter = this.presenterProvider(message.channel as TextChannel);
    await presenter.update(presenter.format(update, overall));
  }
}

// Usage
const service = new IngestionService(
  (channel) => new DiscordProgressPresenter({ channel, logger }),
  logger
);
```

## Pattern 7: Registry Pattern for Multiple Implementations

Use a registry when you have multiple implementations of the same interface.

```typescript
class CommandHandlerRegistry implements ICommandHandlerRegistry {
  private handlers: CommandHandler[] = [];
  
  register(handler: CommandHandler): void {
    this.handlers.push(handler);
  }
  
  async dispatch(context: CommandContext): Promise<CommandResult> {
    for (const handler of this.handlers) {
      if (await handler.canHandle(context)) {
        return handler.handle(context);
      }
    }
    return { success: false, error: new Error("No handler found") };
  }
}

// Usage
const registry = new CommandHandlerRegistry();
registry.register(new StatsCommandHandler(repository));
registry.register(new CrawlCommandHandler(crawlService, queue));
```

## Testing with DI

Dependency injection makes testing straightforward:

```typescript
describe("CrawlCommandHandler", () => {
  it("should queue discovered URLs", async () => {
    // Arrange
    const mockCrawlService = {
      crawl: jest.fn().mockResolvedValue({
        discoveredUrls: ["https://example.com/page1"]
      })
    };
    const mockQueue = {
      enqueueUrls: jest.fn()
    };
    const mockLogger = {
      info: jest.fn(),
      error: jest.fn()
    };
    
    const handler = new CrawlCommandHandler(
      mockCrawlService as any,
      mockQueue as any,
      mockLogger as any
    );
    
    // Act
    const result = await handler.handle(mockContext);
    
    // Assert
    expect(mockQueue.enqueueUrls).toHaveBeenCalledWith(
      ["https://example.com/page1"],
      expect.anything()
    );
    expect(result.success).toBe(true);
  });
});
```

## Best Practices

1. **Prefer interfaces over concrete classes** for dependencies
2. **Keep constructors simple** - only store references, don't do complex logic
3. **Use factory functions** when object creation is complex
4. **Centralize composition** in a single composition root
5. **Make dependencies readonly** to prevent accidental mutation
6. **Use optional dependencies** with sensible defaults
7. **Document dependencies** in class/interface documentation

## Breaking Changes Policy

When modifying interfaces:

1. **Adding optional properties**: Non-breaking
2. **Adding required properties**: Breaking - requires updating all implementations
3. **Removing properties**: Breaking - requires updating all implementations
4. **Changing property types**: Breaking - requires updating all implementations
5. **Changing method signatures**: Breaking - requires updating all implementations

For breaking changes:
- Increment major version
- Document migration path
- Provide deprecation period if possible
- Update all sibling work items simultaneously

## Migration Example

When changing an interface:

```typescript
// Old interface (v1)
interface ProgressPresenter {
  format(update: ProgressUpdate): string;
  update(content: string): Promise<void>;
}

// New interface (v2) - breaking change
interface ProgressPresenter {
  format(update: ProgressUpdate, overall: IngestionProgress): string;  // Added parameter
  update(content: string, options?: { ephemeral?: boolean }): Promise<void>;  // Added optional parameter
  clear(): Promise<void>;  // New method
}

// Migration: Implementations must be updated to support v2
```
 */

import type { Logger } from "./types.js";

/**
 * Service locator interface for runtime dependency resolution
 * 
 * Use sparingly - prefer constructor injection. Service locator is useful
 * when you need to resolve dependencies dynamically based on runtime conditions.
 * 
 * @example
 * ```typescript
 * class DynamicCommandHandler {
 *   constructor(private readonly serviceLocator: ServiceLocator) {}
 *   
 *   async handle(context: CommandContext): Promise<void> {
 *     // Resolve dependency dynamically
 *     const repository = this.serviceLocator.resolve<LinkRepository>("LinkRepository");
 *   }
 * }
 * ```
 */
export interface ServiceLocator {
  /**
   * Register a service with the locator
   * @param key - Unique identifier for the service
   * @param instance - Service instance or factory function
   */
  register<T>(key: string, instance: T | (() => T)): void;

  /**
   * Resolve a service by key
   * @param key - Service identifier
   * @returns Service instance
   * @throws Error if service not found
   */
  resolve<T>(key: string): T;

  /**
   * Check if a service is registered
   * @param key - Service identifier
   * @returns True if registered
   */
  has(key: string): boolean;
}

/**
 * Simple in-memory service locator implementation
 * 
 * @example
 * ```typescript
 * const locator = new SimpleServiceLocator();
 * locator.register("Logger", new Logger("info"));
 * locator.register("Repository", () => new LinkRepository(getDbPool()));
 * 
 * const logger = locator.resolve<Logger>("Logger");
 * ```
 */
export class SimpleServiceLocator implements ServiceLocator {
  private services = new Map<string, unknown>();
  private factories = new Map<string, () => unknown>();

  register<T>(key: string, instance: T | (() => T)): void {
    if (typeof instance === "function") {
      this.factories.set(key, instance as () => T);
    } else {
      this.services.set(key, instance);
    }
  }

  resolve<T>(key: string): T {
    // Check for cached instance
    const cached = this.services.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    // Check for factory
    const factory = this.factories.get(key);
    if (factory) {
      const instance = factory() as T;
      // Cache the instance for future calls
      this.services.set(key, instance);
      return instance;
    }

    throw new Error(`Service not found: ${key}`);
  }

  has(key: string): boolean {
    return this.services.has(key) || this.factories.has(key);
  }
}

/**
 * Configuration provider interface
 * 
 * Abstracts configuration access for testability and flexibility.
 * 
 * @example
 * ```typescript
 * class EnvironmentConfigProvider implements ConfigProvider {
 *   get<T>(key: string, defaultValue?: T): T {
 *     const value = process.env[key];
 *     if (value === undefined && defaultValue === undefined) {
 *       throw new Error(`Missing configuration: ${key}`);
 *     }
 *     return (value as unknown as T) ?? defaultValue!;
 *   }
 * }
 * ```
 */
export interface ConfigProvider {
  /**
   * Get a configuration value
   * @param key - Configuration key
   * @param defaultValue - Default value if not found
   * @returns Configuration value
   */
  get<T>(key: string, defaultValue?: T): T;

  /**
   * Check if a configuration value exists
   * @param key - Configuration key
   * @returns True if exists
   */
  has(key: string): boolean;
}

/**
 * Provider for creating contextual dependencies
 * 
 * @example
 * ```typescript
 * const presenterProvider: ContextualProvider<ProgressPresenter, TextChannel> = 
 *   (channel) => new DiscordProgressPresenter({ channel, logger });
 * ```
 */
export type ContextualProvider<T, TContext> = (context: TContext) => T;
