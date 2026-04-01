import { Client, Intents, TextChannel, ThreadChannel, type Message } from "discord.js";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./logger.js";
import { DiscordBot } from "./discord/client.js";
import { isLikelyContentQuery } from "./query/detector.js";
import { runAddCommand, runQueueCommand, isCliAvailable, CliRunnerError, type AddProgressEvent, type AddResult } from "./bot/cli-runner.js";

// ============================================================================
// Logger
// ============================================================================

const logger = new Logger(config.LOG_LEVEL as any);

// ============================================================================
// Progress Message Formatting
// ============================================================================

/**
 * Format a CLI progress event into a user-friendly Discord message
 */
function formatProgressMessage(event: AddProgressEvent): string {
  switch (event.phase) {
    case "downloading":
      return "⏳ Downloading content...";
    case "extracting":
      return "📝 Extracting text content...";
    case "embedding":
      return "🧠 Generating embeddings...";
    case "completed":
      return `✅ Added to OpenBrain: ${event.title || "URL processed"}`;
    case "failed":
      return `❌ Failed: ${event.message || "Unknown error"}`;
    default:
      return `⏳ Processing: ${event.phase}`;
  }
}

/**
 * Format thread name for URL processing
 */
function formatThreadName(url: string): string {
  // Extract domain from URL for thread name
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, "");
    return `Processing: ${domain}`;
  } catch {
    return "Processing URL";
  }
}

/**
 * User-facing error message for CLI unavailability
 */
const CLI_UNAVAILABLE_MESSAGE = "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.";

// ============================================================================
// Message Reactions
// ============================================================================

const PROCESSING_REACTION = "👀";
const SUCCESS_REACTION = "✅";
const FAILURE_REACTION = "⚠️";

/**
 * Add a reaction to a message
 */
async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch (error) {
    logger.warn("Failed to add reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remove a reaction from a message (removes bot's reaction only)
 */
async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const botUserId = message.client?.user?.id;
    if (!botUserId) return;

    // Get the reaction and remove the bot's reaction
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(botUserId);
    }
  } catch (error) {
    logger.warn("Failed to remove reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Check if CLI is available and reply with error message if not
 * @returns true if CLI is available, false otherwise
 */
async function checkCliAvailability(message: Message): Promise<boolean> {
  logger.debug("Checking CLI availability...", { messageId: message.id });
  
  try {
    const isAvailable = await Promise.race([
      isCliAvailable(),
      new Promise<boolean>((_, reject) => 
        setTimeout(() => reject(new Error("CLI check timeout")), 10000)
      )
    ]);
    
    if (!isAvailable) {
      logger.warn("CLI availability check failed - CLI not found", {
        messageId: message.id,
        channelId: message.channelId,
      });
      await message.reply(CLI_UNAVAILABLE_MESSAGE);
      return false;
    }
    
    logger.debug("CLI is available", { messageId: message.id });
    return true;
  } catch (error) {
    logger.error("CLI availability check error", {
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await message.reply(CLI_UNAVAILABLE_MESSAGE);
    return false;
  }
}

// ============================================================================
// URL Processing
// ============================================================================

/**
 * Extract URLs from message content
 */
function extractUrls(content: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = content.match(urlRegex) || [];
  return [...new Set(matches)]; // Remove duplicates
}

/**
 * Check if message contains a crawl command
 */
function isCrawlCommand(content: string): boolean {
  return /^\s*crawl\s+/i.test(content);
}

/**
 * Extract seed URL from crawl command
 */
function extractCrawlSeedUrl(content: string): string | null {
  const match = content.match(/^\s*crawl\s+(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}



/**
 * Process a URL with threaded progress updates
 * Creates a thread and sends progress events as they occur
 */
async function processUrlWithProgress(
  message: Message,
  url: string
): Promise<void> {
  logger.info("Starting URL processing", { messageId: message.id, url });
  
  let thread: ThreadChannel | null = null;
  
  // Add processing reaction to indicate the bot is working
  await addReaction(message, PROCESSING_REACTION);
  
  try {
    // Try to create a thread for progress updates
    thread = await message.startThread({
      name: formatThreadName(url),
      autoArchiveDuration: 60, // Archive after 1 hour of inactivity
    });
    
    logger.info("Created thread for URL processing", {
      messageId: message.id,
      threadId: thread.id,
      url,
    });
  } catch (error) {
    // Thread creation failed, log and continue without thread
    logger.warn("Failed to create thread for progress updates", {
      messageId: message.id,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  
  try {
    logger.info("Starting CLI add command", { messageId: message.id, url });
    
    // Run the add command with progress tracking
    const addGenerator = runAddCommand(url, {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    });
    
    let lastPhase: string | null = null;
    let eventCount = 0;
    let finalResult: AddResult | undefined;
    
    // Process progress events using manual iteration to capture return value
    logger.info("Waiting for CLI progress events...", { messageId: message.id, url });
    
    while (true) {
      const iteration = await addGenerator.next();
      
      if (iteration.done) {
        // Generator completed - capture the return value
        finalResult = iteration.value;
        logger.info("CLI generator completed", { 
          messageId: message.id, 
          url, 
          eventCount,
          hasResult: !!finalResult 
        });
        break;
      }
      
      // Process yielded progress event
      const event = iteration.value;
      eventCount++;
      logger.info("Received CLI progress event", { 
        messageId: message.id, 
        url, 
        phase: event.phase,
        eventCount 
      });
      
      // Only send update if phase changed (avoid spam)
      if (event.phase !== lastPhase) {
        lastPhase = event.phase;
        
        const progressMsg = formatProgressMessage(event);

        // Always ensure URLs shown to users are wrapped in backticks to avoid embeds.
        // If event contains a url or title, prefer showing the title wrapped in ticks.
        const safeProgressMsg = ((): string => {
          try {
            if (event.title) return progressMsg.replace(event.title, `\`${event.title}\``);
            if (event.url) return progressMsg.replace(event.url, `\`${event.url}\``);
            return progressMsg;
          } catch {
            return progressMsg;
          }
        })();

        if (thread) {
          try {
            await thread.send(safeProgressMsg);
          } catch (error) {
            logger.warn("Failed to send progress update to thread; falling back to channel reply", {
              threadId: thread.id,
              phase: event.phase,
              error: error instanceof Error ? error.message : String(error),
            });
            // Fallback: reply in channel so user still receives updates
            try {
              await message.reply(safeProgressMsg);
            } catch (err) {
              logger.warn("Failed to send fallback progress reply to channel", {
                messageId: message.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else {
          // No thread available -> send progress updates to channel (safe)
          try {
            await message.reply(safeProgressMsg);
          } catch (err) {
            logger.warn("Failed to send progress update to channel", {
              messageId: message.id,
              phase: event.phase,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
    
    if (finalResult) {
      logger.info("CLI processing complete", { 
        messageId: message.id, 
        url, 
        success: finalResult.success,
        title: finalResult.title,
        error: finalResult.error
      });
      
      if (finalResult.success) {
        // Remove processing reaction and add success reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, SUCCESS_REACTION);
        
        // Ensure title or URL displayed is wrapped in backticks to avoid embeds
        const displayName = finalResult.title ? `\`${finalResult.title}\`` : `\`${url}\``;
        const successMsg = `✅ Added: ${displayName}`;

        if (thread) {
          try {
            await thread.send(successMsg);
            // Archive the thread after successful completion
            await thread.setArchived(true);
          } catch (error) {
            logger.warn("Failed to send final success message to thread; falling back to channel reply", {
              threadId: thread.id,
              error: error instanceof Error ? error.message : String(error),
            });
            // Fallback to channel reply
            try {
              await message.reply(successMsg);
            } catch (err) {
              logger.warn("Failed to send fallback success reply to channel", {
                messageId: message.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else {
          // Fallback to message reply if no thread
          await message.reply(successMsg);
        }
      } else {
        // Remove processing reaction and add failure reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, FAILURE_REACTION);
        
        const displayUrl = `\`${url}\``;
        const errorBody = finalResult.error || CLI_UNAVAILABLE_MESSAGE;
        const errorMsg = `❌ Failed to add ${displayUrl}\n\n${errorBody}`;

        if (thread) {
          try {
            await thread.send(errorMsg);
            // Archive the thread after failure
            await thread.setArchived(true);
          } catch (error) {
            logger.warn("Failed to send final error message to thread; falling back to channel reply", {
              threadId: thread.id,
              error: error instanceof Error ? error.message : String(error),
            });
            try {
              await message.reply(errorMsg);
            } catch (err) {
              logger.warn("Failed to send fallback error reply to channel", {
                messageId: message.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else {
          // Fallback to message reply if no thread
          await message.reply(errorMsg);
        }
      }
    } else {
      logger.error("CLI generator did not return a result", { 
        messageId: message.id, 
        url
      });
    }
  } catch (error) {
    logger.error("Exception during URL processing", {
      messageId: message.id,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Handle CLI errors
    if (error instanceof CliRunnerError) {
      logger.error("CLI error during URL processing", {
        messageId: message.id,
        url,
        exitCode: error.exitCode,
        stderr: error.stderr,
      });
    }
    
    // Remove processing reaction and add failure reaction
    await removeReaction(message, PROCESSING_REACTION);
    await addReaction(message, FAILURE_REACTION);
    
    const errorMsg = `❌ Failed to add URL\n\n${CLI_UNAVAILABLE_MESSAGE}`;
    
    if (thread) {
      try {
        await thread.send(errorMsg);
        await thread.setArchived(true);
      } catch (sendError) {
        logger.error("Failed to send error message to thread", {
          threadId: thread.id,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
    } else {
      await message.reply(errorMsg);
    }
  }
}

/**
 * Suppress embeds on a message if the bot has the MANAGE_MESSAGES permission.
 * Returns true if suppression was attempted and succeeded, false otherwise.
 */
async function suppressEmbedsIfPermitted(message: Message): Promise<boolean> {
  try {
    const guild = message.guild;
    if (!guild) {
      logger.debug("Message not in a guild; cannot suppress embeds", { messageId: message.id });
      return false;
    }

    const botUserId = message.client?.user?.id;
    if (!botUserId) {
      logger.warn("Could not determine bot user id for permission check", { messageId: message.id });
      return false;
    }

    // Fetch the bot's guild member to get up-to-date permissions
    const botMember = await guild.members.fetch(botUserId);
    if (!botMember) {
      logger.warn("Failed to fetch bot guild member", { messageId: message.id });
      return false;
    }

    if (!botMember.permissions.has("MANAGE_MESSAGES")) {
      logger.warn("Bot lacks MANAGE_MESSAGES permission; cannot suppress embeds", { messageId: message.id });
      return false;
    }

    // Call suppressEmbeds if available on this Message object
    const suppressFn = (message as any).suppressEmbeds;
    if (typeof suppressFn === "function") {
      await suppressFn.call(message, true);
      logger.debug("Suppressed embeds on message", { messageId: message.id });
      return true;
    }

    logger.warn("suppressEmbeds method not available on message object", { messageId: message.id });
    return false;
  } catch (err) {
    logger.warn("Error while attempting to suppress embeds", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ============================================================================
// Bot Initialization
// ============================================================================

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
  onInteraction: async (interaction) => {
    if (!interaction.isCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === "stats") {
      await interaction.reply("Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
    }
  },
  onMonitoredMessage: async (message) => {
    // Handle content queries
    if (isLikelyContentQuery(message.content)) {
      await message.reply("Query functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
      return;
    }
    
    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id
    });
    
    // Handle crawl commands
    if (isCrawlCommand(message.content)) {
      logger.info("Crawl command detected", { messageId: message.id });

      const seed = extractCrawlSeedUrl(message.content);
      if (!seed) {
        await message.reply("Please pass a seed URL to crawl, for example: `crawl https://example.com`.");
        return;
      }

      // Check CLI availability before queueing
      if (!(await checkCliAvailability(message))) {
        return;
      }
      
      // Add processing reaction
      await addReaction(message, PROCESSING_REACTION);
      
      // Try to queue via CLI runner
      try {
        const queueResult = await runQueueCommand(seed, {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
        });
        
        if (queueResult.success) {
          // Remove processing reaction and add success reaction
          await removeReaction(message, PROCESSING_REACTION);
          await addReaction(message, SUCCESS_REACTION);
          
          // Wrap in code ticks to avoid Discord creating an embed in the reply
          await message.reply(`Queued URL for crawling: \`${seed}\``);
        } else {
          // Remove processing reaction and add failure reaction
          await removeReaction(message, PROCESSING_REACTION);
          await addReaction(message, FAILURE_REACTION);
          
          // Wrap the URL in angle brackets to prevent Discord creating embeds,
          // and leave a blank line before the echoed error message.
          await message.reply(`Failed to queue URL\n\n${queueResult.error || CLI_UNAVAILABLE_MESSAGE}`);
        }
      } catch (error) {
        // Remove processing reaction and add failure reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, FAILURE_REACTION);
        
        if (error instanceof CliRunnerError) {
          logger.error("CLI error during queue command", {
            messageId: message.id,
            url: seed,
            exitCode: error.exitCode,
            stderr: error.stderr,
          });
          await message.reply(`❌ Failed to queue URL\n\n${CLI_UNAVAILABLE_MESSAGE}`);
        } else {
          throw error;
        }
      }

      return;
    }

    // Extract URLs from message
    const urls = extractUrls(message.content);
    if (urls.length > 0) {
      logger.info("Found URLs in message", { urls, messageId: message.id });

      // Check CLI availability before processing URLs
      if (!(await checkCliAvailability(message))) {
        return;
      }
      
      // Add URLs using CLI runner with threaded progress updates
      for (const url of urls) {
        await processUrlWithProgress(message, url);
      }
    }
  }
});

// ============================================================================
// Startup and Shutdown
// ============================================================================

async function startBot(): Promise<void> {
  try {
    await bot.start();
    logger.info("Bot started successfully");
  } catch (error) {
    logger.error("Bot startup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}

// Track shutdown state
let isShuttingDown = false;

// Graceful shutdown cleanup
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info("Shutdown already in progress, forcing exit");
    process.exit(1);
  }
  
  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  
  try {
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during graceful shutdown", {
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start the bot
startBot();
