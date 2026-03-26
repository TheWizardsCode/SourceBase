/**
 * CommandHandler interface for Discord bot command processing
 * 
 * This interface defines the contract for all command handlers in the system.
 * Implementations handle specific Discord slash commands and interactions.
 * 
 * @module command-handler
 * @example
 * ```typescript
 * // Implementation example
 * class StatsCommandHandler implements CommandHandler {
 *   constructor(private readonly repository: LinkRepository) {}
 *   
 *   async canHandle(context: CommandContext): Promise<boolean> {
 *     return context.interaction.commandName === "stats";
 *   }
 *   
 *   async handle(context: CommandContext): Promise<CommandResult> {
 *     const stats = await this.repository.getStats();
 *     await context.interaction.reply({ embeds: [this.formatStats(stats)] });
 *     return { success: true };
 *   }
 * }
 * 
 * // Registration example
 * const handlers: CommandHandler[] = [
 *   new StatsCommandHandler(repository),
 *   new CrawlCommandHandler(crawlService, documentQueue)
 * ];
 * 
 * // Usage in bot
 * bot.onInteraction = async (interaction) => {
 *   if (!interaction.isCommand()) return;
 *   
 *   const context = createCommandContext(interaction);
 *   const handler = await findHandler(handlers, context);
 *   
 *   if (handler) {
 *     const result = await handler.handle(context);
 *     if (!result.success) {
 *       logger.error("Command failed", { error: result.error });
 *     }
 *   }
 * };
 * ```
 */

import type { CommandInteraction } from "discord.js";
import type { CommandContext, Result } from "./types.js";

/**
 * Result of command execution
 */
export interface CommandResult extends Result<void> {
  /** Optional response data for the command */
  response?: {
    /** Message content to send */
    content?: string;
    /** Whether the response should be ephemeral (only visible to command user) */
    ephemeral?: boolean;
  };
}

/**
 * Interface for Discord command handlers
 * 
 * All command handlers must implement this interface to be registered
 * and executed by the bot's command dispatch system.
 * 
 * @example
 * ```typescript
 * export class CrawlCommandHandler implements CommandHandler {
 *   readonly commandName = "crawl";
 *   
 *   constructor(
 *     private readonly crawlService: CrawlService,
 *     private readonly documentQueue: DocumentQueue,
 *     private readonly logger: Logger
 *   ) {}
 *   
 *   async canHandle(context: CommandContext): Promise<boolean> {
 *     return context.interaction.commandName === this.commandName;
 *   }
 *   
 *   async handle(context: CommandContext): Promise<CommandResult> {
 *     const { interaction } = context;
 *     
 *     // Validate command input
 *     const urlOption = interaction.options.getString("url");
 *     if (!urlOption) {
 *       return {
 *         success: false,
 *         error: new Error("URL parameter is required")
 *       };
 *     }
 *     
 *     try {
 *       // Execute crawl
 *       const result = await this.crawlService.crawl(urlOption);
 *       
 *       // Queue discovered URLs
 *       if (result.discoveredUrls.length > 0) {
 *         await this.documentQueue.enqueueUrls(result.discoveredUrls, interaction);
 *       }
 *       
 *       return {
 *         success: true,
 *         response: {
 *           content: `Crawl complete! Found ${result.discoveredUrls.length} URLs.`
 *         }
 *       };
 *     } catch (error) {
 *       this.logger.error("Crawl failed", { error });
 *       return {
 *         success: false,
 *         error: error instanceof Error ? error : new Error(String(error))
 *       };
 *     }
 *   }
 * }
 * ```
 */
export interface CommandHandler {
  /**
   * Check if this handler can process the given command
   * 
   * @param context - The command context containing interaction details
   * @returns Promise resolving to true if this handler can handle the command
   * 
   * @example
   * ```typescript
   * async canHandle(context: CommandContext): Promise<boolean> {
   *   return context.interaction.commandName === "stats";
   * }
   * ```
   */
  canHandle(context: CommandContext): Promise<boolean>;

  /**
   * Execute the command
   * 
   * @param context - The command context containing interaction and channel
   * @returns Promise resolving to the command result
   * @throws Never throws - all errors should be caught and returned as CommandResult
   * 
   * @example
   * ```typescript
   * async handle(context: CommandContext): Promise<CommandResult> {
   *   try {
   *     const data = await this.fetchData();
   *     await context.interaction.reply(this.formatResponse(data));
   *     return { success: true };
   *   } catch (error) {
   *     return {
   *       success: false,
   *       error: error instanceof Error ? error : new Error(String(error))
   *     };
   *   }
   * }
   * ```
   */
  handle(context: CommandContext): Promise<CommandResult>;
}

/**
 * Factory function type for creating command handlers
 * Useful for dependency injection and testing
 */
export type CommandHandlerFactory = () => CommandHandler | CommandHandler[];

/**
 * Registry for command handlers
 * Manages handler registration and dispatch
 * 
 * @example
 * ```typescript
 * const registry = new CommandHandlerRegistry();
 * registry.register(new StatsCommandHandler(repository));
 * registry.register(new CrawlCommandHandler(crawlService, queue));
 * 
 * // In bot
 * bot.onInteraction = async (interaction) => {
 *   if (!interaction.isCommand()) return;
 *   const context = createCommandContext(interaction);
 *   await registry.dispatch(context);
 * };
 * ```
 */
export interface CommandHandlerRegistry {
  /**
   * Register a command handler
   * @param handler - The handler to register
   */
  register(handler: CommandHandler): void;

  /**
   * Dispatch a command to the appropriate handler
   * @param context - The command context
   * @returns The command result or null if no handler found
   */
  dispatch(context: CommandContext): Promise<CommandResult | null>;

  /**
   * Get all registered handlers
   * @returns Array of registered handlers
   */
  getHandlers(): CommandHandler[];
}

/**
 * Helper function to find the appropriate handler for a command
 * 
 * @param handlers - Array of available handlers
 * @param context - The command context
 * @returns The first handler that can handle the command, or undefined
 * 
 * @example
 * ```typescript
 * const handler = await findHandler(handlers, context);
 * if (handler) {
 *   await handler.handle(context);
 * } else {
 *   await context.interaction.reply("Unknown command");
 * }
 * ```
 */
export async function findHandler(
  handlers: CommandHandler[],
  context: CommandContext
): Promise<CommandHandler | undefined> {
  for (const handler of handlers) {
    if (await handler.canHandle(context)) {
      return handler;
    }
  }
  return undefined;
}

/**
 * Helper function to create a command context from an interaction
 * 
 * @param interaction - The Discord command interaction
 * @returns Command context ready for handler execution
 * 
 * @example
 * ```typescript
 * const context = createCommandContext(interaction);
 * const result = await handler.handle(context);
 * ```
 */
export function createCommandContext(
  interaction: CommandInteraction
): CommandContext {
  return {
    interaction,
    channel: interaction.channel! as Extract<CommandContext["channel"], { type: any }>,
    client: interaction.client
  };
}
