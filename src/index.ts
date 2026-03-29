import { Client, Intents, TextChannel, type Message } from "discord.js";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./logger.js";
import { DiscordBot } from "./discord/client.js";
import { isLikelyContentQuery } from "./query/detector.js";
import { runAddCommand, runQueueCommand, runStatsCommand, type AddResult } from "./bot/cli-runner.js";
import type { CliProgressEvent, ProgressPhase, QueueUpdateStatus, PendingQueueItem } from "./interfaces/cli-types.js";

// ============================================================================
// Logger
// ============================================================================

const logger = new Logger(config.LOG_LEVEL);

// ============================================================================
// Progress Message Formatting
// ============================================================================

/**
 * Format a CLI progress event into a Discord message
 */
function formatProgressMessage(event: CliProgressEvent): string {
  const phaseEmoji: Record<ProgressPhase, string> = {
    downloading: "⬇️",
    extracting_links: "🔗",
    updating: "🔄",
    summarizing: "✍️",
    embedding: "🔢",
    storing: "💾",
    completed: "✅",
    failed: "❌"
  };

  const phaseLabel: Record<ProgressPhase, string> = {
    downloading: "Downloading",
    extracting_links: "Extracting",
    updating: "Updating",
    summarizing: "Summarizing",
    embedding: "Embedding",
    storing: "Storing",
    completed: "Completed",
    failed: "Failed"
  };

  const isMultiUrl = event.total > 1;
  const progressCounter = isMultiUrl ? `[${event.current}/${event.total}] ` : "";
  const emoji = phaseEmoji[event.phase];
  const label = phaseLabel[event.phase];

  // For completed phase, show the summary instead of the URL
  if (event.phase === "completed" && event.summary) {
    const title = event.title || "Untitled";
    let summary = event.summary;
    
    // Truncate summary if needed to fit within Discord's limit
    const reservedSpace = 100;
    if (summary.length > 2000 - reservedSpace - title.length) {
      summary = summary.slice(0, 2000 - reservedSpace - title.length - 3) + "...";
    }
    
    return `${emoji} ${progressCounter}${title}\n\n${summary}`;
  }

  // For chunk-level progress (summarizing/embedding), show chunk info
  if (event.chunkCurrent && event.chunkTotal && (event.phase === "summarizing" || event.phase === "embedding")) {
    const chunkInfo = ` (chunk ${event.chunkCurrent}/${event.chunkTotal})`;
    return `${emoji} ${progressCounter}${label}${chunkInfo}: <${event.url}>`;
  }

  let message = `${emoji} ${progressCounter}${label}: <${event.url}>`;

  if (event.phase === "failed" && event.message) {
    message += `\n   Error: ${event.message}`;
  }

  // Final safety check - truncate if still too long
  if (message.length > 2000) {
    message = message.slice(0, 1997) + "...";
  }

  return message;
}

/**
 * Format final message after processing completes
 */
function formatFinalMessage(event: CliProgressEvent, totalCompleted: number, totalFailed: number, totalUrls: number): string {
  let finalContent: string;
  
  if (event.phase === "completed" && event.summary) {
    const title = event.title || "Untitled";
    let summary = event.summary;
    // Make title a clickable link to the original article
    const titleLink = `[${title}](${event.url})`;
    // Truncate summary if needed
    const reservedSpace = 50;
    if (summary.length > 2000 - reservedSpace - title.length) {
      summary = summary.slice(0, 2000 - reservedSpace - title.length - 3) + "...";
    }
    // Use update icon for updated documents, tick for new documents
    const icon = event.isUpdate ? "🔄" : "✅";
    finalContent = `${icon} ${titleLink}\n\n${summary}`;
  } else if (event.phase === "failed") {
    finalContent = `❌ Failed to process <${event.url}>\n   Error: ${event.message || "Unknown error"}`;
  } else {
    finalContent = formatProgressMessage(event);
  }

  // Add summary line for multi-URL runs
  if (totalUrls > 1) {
    const summary = totalFailed > 0
      ? `\n\n📊 Final: ${totalCompleted} succeeded, ${totalFailed} failed`
      : `\n\n✅ All ${totalCompleted} URLs processed successfully`;
    finalContent += summary;
  }

  return finalContent;
}

// ============================================================================
// Queue Management
// ============================================================================

/**
 * Format queue status message
 */
function formatQueueMessage(url: string, queueSize: number, status: QueueUpdateStatus): string {
  const urlDisplay = url.length > 60 ? url.slice(0, 57) + '...' : url;

  if (status === 'skipped') {
    return `⏭️ Skipping <${urlDisplay}> as it is already in the queue. Queue length: ${queueSize}`;
  } else if (status === 'added') {
    return `📥 Added <${urlDisplay}> to Queue. Queue length: ${queueSize}`;
  } else {
    return `⚙️ Processing <${urlDisplay}> from the Queue. Queue length: ${queueSize}`;
  }
}

// Track status messages per Discord message
const statusMessages = new Map<string, Message>();

// Track queue status message per channel
const queueStatusMessages = new Map<string, Message>();

// Cache of real Discord channels for synthetic messages loaded from database
const channelCache = new Map<string, TextChannel>();

// Track pending items from restart
let pendingItemsFromRestart: Array<PendingQueueItem> = [];

// ============================================================================
// URL Processing
// ============================================================================

/**
 * Process URLs from a message using subprocess calls
 */
async function processUrls(urls: string[], message: Message): Promise<void> {
  const channelId = message.channelId;
  const messageId = message.id;
  const authorId = message.author.id;
  
  // Create initial status message
  const initialContent = urls.length === 1 
    ? `⏳ Processing <${urls[0]}>...`
    : `⏳ Processing ${urls.length} URLs...`;
  
  const statusMsg = await message.channel.send(initialContent);
  statusMessages.set(messageId, statusMsg);
  
  let completedCount = 0;
  let failedCount = 0;
  const finalResults: Array<{ url: string; success: boolean; title?: string }> = [];
  
  // Process each URL
  for (const url of urls) {
    try {
      // Run the add command and process progress events
      const addGenerator = runAddCommand(url, { channelId, messageId, authorId });
      
      for await (const event of addGenerator) {
        // Update progress message
        const content = formatProgressMessage(event);
        if (statusMsg.content !== content) {
          await statusMsg.edit(content);
        }
      }
      
      // Get final result by tracking last event
      const finalResult: AddResult = {
        success: true,
        url
      };
      
      if (finalResult.success) {
        completedCount++;
        finalResults.push({ url, success: true, title: finalResult.title });
        
        // Apply success reaction
        try {
          await message.react(config.INGEST_SUCCESS_REACTION);
        } catch (err) {
          logger.warn("Failed to apply success reaction", { url, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        failedCount++;
        finalResults.push({ url, success: false });
        
        // Apply failure reaction
        try {
          await message.react(config.INGEST_FAILURE_REACTION);
        } catch (err) {
          logger.warn("Failed to apply failure reaction", { url, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (error) {
      failedCount++;
      finalResults.push({ url, success: false });
      
      logger.error("Failed to process URL", { 
        url, 
        error: error instanceof Error ? error.message : String(error) 
      });
      
      // Apply failure reaction
      try {
        await message.react(config.INGEST_FAILURE_REACTION);
      } catch (err) {
        logger.warn("Failed to apply failure reaction", { url, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  
  // Delete status message and send final summary
  try {
    await statusMsg.delete();
  } catch (err) {
    // Message might already be deleted, ignore
  }
  
  // Send final messages for each URL
  for (const result of finalResults) {
    const finalEvent: CliProgressEvent = {
      type: "progress",
      phase: result.success ? "completed" : "failed",
      url: result.url,
      current: 1,
      total: 1,
      timestamp: new Date().toISOString(),
      title: result.title,
      isUpdate: false
    };
    
    const finalContent = formatFinalMessage(finalEvent, completedCount, failedCount, urls.length);
    await message.channel.send(finalContent);
  }
  
  // Clean up status messages
  statusMessages.delete(messageId);
}

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
 * Perform crawl and return discovered URLs
 * Note: This uses subprocess since we don't have direct crawl service access
 */
async function performCrawl(content: string): Promise<{ seedUrl: string; discoveredUrls: string[] } | null> {
  const seedUrl = extractCrawlSeedUrl(content);
  if (!seedUrl) {
    return null;
  }
  
  // For now, return just the seed URL since full crawl via subprocess
  // would require a crawl command to be implemented in the CLI
  // TODO: Implement `sb crawl` command in CLI
  return {
    seedUrl,
    discoveredUrls: [seedUrl]
  };
}

// ============================================================================
// Queue Operations
// ============================================================================

/**
 * Queue URLs for processing via subprocess
 */
async function queueUrls(urls: string[], message: Message): Promise<void> {
  const channelId = message.channelId;
  const messageId = message.id;
  const authorId = message.author.id;
  
  for (const url of urls) {
    try {
      const result = await runQueueCommand(url, { channelId, messageId, authorId });
      
      if (result.success) {
        const queueContent = formatQueueMessage(url, urls.length, 'added');
        const queueMsg = await message.channel.send(queueContent);
        queueStatusMessages.set(channelId, queueMsg);
        
        logger.info("URL queued", { url, queueId: result.id });
      } else {
        logger.warn("Failed to queue URL", { url, error: result.error });
      }
    } catch (error) {
      logger.error("Error queueing URL", { 
        url, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
}

// ============================================================================
// Stats Command
// ============================================================================

/**
 * Handle the /stats slash command
 */
async function handleStatsCommand(interaction: any): Promise<void> {
  await interaction.deferReply();
  
  try {
    const stats = await runStatsCommand();
    
    const embed = {
      title: "📊 Database Statistics",
      color: 0x3498db,
      fields: [
        {
          name: "📚 Total Links",
          value: stats.totalLinks.toLocaleString(),
          inline: true
        },
        {
          name: "📝 With Summaries",
          value: `${stats.linksWithSummaries.toLocaleString()} (${((stats.linksWithSummaries / stats.totalLinks) * 100).toFixed(1)}%)`,
          inline: true
        },
        {
          name: "🔢 With Embeddings",
          value: `${stats.linksWithEmbeddings.toLocaleString()} (${((stats.linksWithEmbeddings / stats.totalLinks) * 100).toFixed(1)}%)`,
          inline: true
        },
        {
          name: "📄 With Content",
          value: `${stats.linksWithContent.toLocaleString()} (${((stats.linksWithContent / stats.totalLinks) * 100).toFixed(1)}%)`,
          inline: true
        },
        {
          name: "🎬 With Transcripts",
          value: `${stats.linksWithTranscripts.toLocaleString()} (${((stats.linksWithTranscripts / stats.totalLinks) * 100).toFixed(1)}%)`,
          inline: true
        },
        {
          name: "⏰ Recent Activity",
          value: [
            `Last 24h: ${stats.linksLast24Hours}`,
            `Last 7d: ${stats.linksLast7Days}`,
            `Last 30d: ${stats.linksLast30Days}`
          ].join("\n"),
          inline: false
        }
      ],
      timestamp: new Date().toISOString()
    };
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Failed to get stats", {
      error: error instanceof Error ? error.message : String(error)
    });
    await interaction.editReply("❌ Failed to retrieve statistics");
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
      await handleStatsCommand(interaction);
    }
  },
  onMonitoredMessage: async (message) => {
    // Handle content queries
    if (isLikelyContentQuery(message.content)) {
      // For now, respond that query functionality is not available via subprocess
      // TODO: Implement query command in CLI
      await message.reply("Query functionality is temporarily unavailable while transitioning to subprocess architecture.");
      return;
    }
    
    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id
    });
    
    // Handle crawl commands
    if (isCrawlCommand(message.content)) {
      logger.info("Crawl command detected", { messageId: message.id });
      
      const crawlStatusMsg = await message.channel.send("🔍 Starting crawl...");
      
      try {
        const result = await performCrawl(message.content);
        
        if (!result) {
          await crawlStatusMsg.edit("❌ Invalid crawl command. Usage: `crawl https://example.com`");
          return;
        }
        
        if (result.discoveredUrls.length === 0) {
          await crawlStatusMsg.edit(`🔍 Crawl complete. No URLs discovered from ${result.seedUrl}`);
          return;
        }
        
        // Queue discovered URLs
        await queueUrls(result.discoveredUrls, message);
        
        await crawlStatusMsg.edit(`🔍 Crawled ${result.seedUrl} - ${result.discoveredUrls.length} URL(s) queued for processing`);
        
        logger.info("Crawl complete, URLs queued", {
          messageId: message.id,
          discoveredCount: result.discoveredUrls.length
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Crawl failed", { messageId: message.id, error: errorMessage });
        await crawlStatusMsg.edit(`❌ Crawl failed: ${errorMessage}`);
      }
      return;
    }
    
    // Extract and process URLs from message
    const urls = extractUrls(message.content);
    if (urls.length > 0) {
      await processUrls(urls, message);
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
    // Send maintenance notifications to channels
    const maintenanceMessage = "🔄 Bot Closing Down for Maintenance - Processing will resume shortly";
    const channelIds = new Set<string>([...queueStatusMessages.keys(), ...channelCache.keys()]);
    
    const notificationPromises: Promise<void>[] = [];
    
    for (const channelId of channelIds) {
      const cached = channelCache.get(channelId);
      if (cached) {
        notificationPromises.push(
          (async () => {
            try {
              await cached.send(maintenanceMessage);
            } catch (err) {
              logger.warn("Failed to send maintenance notification", { channelId, error: err instanceof Error ? err.message : String(err) });
            }
          })()
        );
      }
    }
    
    // Wait for notifications with timeout
    await Promise.race([
      Promise.all(notificationPromises),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
    ]).catch(err => {
      logger.warn("Some maintenance notifications timed out", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    
    // Update or cleanup status messages
    const cleanupPromises: Promise<void>[] = [];
    
    for (const [key, msg] of statusMessages) {
      cleanupPromises.push(
        (async () => {
          try {
            await msg.edit("⏸️ Processing paused - bot restarting");
          } catch {
            try {
              await msg.delete();
            } catch {
              // Ignore
            }
          }
        })()
      );
    }
    
    for (const [channelId, msg] of queueStatusMessages) {
      cleanupPromises.push(
        (async () => {
          try {
            await msg.edit("⏸️ Queue processing paused - bot restarting");
          } catch {
            try {
              await msg.delete();
            } catch {
              // Ignore
            }
          }
        })()
      );
    }
    
    // Wait for cleanup with timeout
    await Promise.race([
      Promise.all(cleanupPromises),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
    ]).catch(err => {
      logger.warn("Some message cleanup timed out", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    
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
