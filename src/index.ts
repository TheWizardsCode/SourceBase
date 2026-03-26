import { Client, Intents, TextChannel, type Message } from "discord.js";
import { getQdrantVectorStore, type QdrantVectorStore } from "./vector/qdrant-store.js";
import { config } from "./config.js";
import { getDbPool, closeDbPool } from "./db/client.js";
import { LinkRepository } from "./db/repository.js";
import { DocumentQueueRepository } from "./db/queue-repository.js";
import { DiscordBot } from "./discord/client.js";
import { ArticleExtractorContentExtractor, PdfContentExtractor, FileContentExtractor } from "./ingestion/extractor.js";
import { IngestionService } from "./ingestion/service.js";
import { BackfillService } from "./ingestion/backfill.js";
import type { ProgressUpdate, IngestionProgress, ProgressPhase } from "./ingestion/service.js";
import { DocumentQueue, type QueueUpdateStatus } from "./ingestion/queue.js";
import { CrawlService } from "./ingestion/crawl.js";
import { extractCrawlSeedUrl } from "./ingestion/url.js";
import { YouTubeApiClient } from "./ingestion/youtube.js";
import { OpenAiCompatibleLlmClient } from "./llm/client.js";
import { OpenAiCompatibleEmbeddingProvider } from "./llm/embeddings.js";
import { Logger } from "./logger.js";
import { StartupRecoveryService } from "./ingestion/startup-recovery.js";
import { isLikelyContentQuery } from "./query/detector.js";
import { QueryService } from "./query/service.js";

// Helper to format progress messages
function formatProgressMessage(update: ProgressUpdate, overall: IngestionProgress): string {
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

  const isMultiUrl = overall.urls.length > 1;
  const progressCounter = isMultiUrl ? `[${update.current}/${update.total}] ` : "";
  const emoji = phaseEmoji[update.phase];
  const label = phaseLabel[update.phase];

  // For completed phase, show the summary instead of the URL
  if (update.phase === "completed" && update.summary) {
    const title = update.title || "Untitled";
    let summary = update.summary;
    
    // Truncate summary if needed to fit within Discord's limit
    // Reserve space for emoji, counter, title, and newlines
    const reservedSpace = 100;
    if (summary.length > 2000 - reservedSpace - title.length) {
      summary = summary.slice(0, 2000 - reservedSpace - title.length - 3) + "...";
    }
    
    return `${emoji} ${progressCounter}${title}\n\n${summary}`;
  }

  // For chunk-level progress (summarizing/embedding), show chunk info
  if (update.chunkCurrent && update.chunkTotal && (update.phase === "summarizing" || update.phase === "embedding")) {
    const chunkInfo = ` (chunk ${update.chunkCurrent}/${update.chunkTotal})`;
    return `${emoji} ${progressCounter}${label}${chunkInfo}: <${update.url}>`;
  }

  let message = `${emoji} ${progressCounter}${label}: <${update.url}>`

  if (update.phase === "failed" && update.message) {
    message += `\n   Error: ${update.message}`;
  }

  if (isMultiUrl && (update.phase === "completed" || update.phase === "failed")) {
    const completed = overall.completed;
    const failed = overall.failed;
    const total = overall.urls.length;
    message += `\n   Progress: ${completed} succeeded, ${failed} failed (${completed + failed}/${total})`;
  }

  // Final safety check - truncate if still too long
  if (message.length > 2000) {
    message = message.slice(0, 1997) + "...";
  }

  return message;
}

const logger = new Logger(config.LOG_LEVEL);
const repository = new LinkRepository(getDbPool());
const llmClient = new OpenAiCompatibleLlmClient({
  baseUrl: config.LLM_BASE_URL,
  model: config.LLM_MODEL,
  embeddingModel: config.LLM_EMBEDDING_MODEL,
  maxRetries: config.LLM_MAX_RETRIES,
  retryDelayMs: config.LLM_RETRY_DELAY_MS
});
const embeddingProvider = new OpenAiCompatibleEmbeddingProvider(llmClient);

// Qdrant vector store for high-dimensional embeddings (supports >2000D, unlike pgvector HNSW)
const qdrantStore: QdrantVectorStore = getQdrantVectorStore();

// Wrapper to make qdrantStore compatible with QueryService's SearchableLinkStore interface
const qdrantSearchAdapter = {
  searchSimilarLinks: (embedding: number[], limit: number) => qdrantStore.search(embedding, limit),
};

const queryService = new QueryService(qdrantSearchAdapter, embeddingProvider);

// Initialize YouTube API client if API key is configured
const youtubeClient = new YouTubeApiClient(logger);
if (youtubeClient.isConfigured()) {
  logger.info("YouTube API client initialized");
} else {
  logger.warn("YouTube API key not configured, YouTube URLs will use generic extraction");
}

// Track status messages per Discord message
const statusMessages = new Map<string, Message>();

// Track queue status message per channel
const queueStatusMessages = new Map<string, Message>();

// Keep track of pending items loaded from database for status restoration
let pendingItemsFromRestart: Array<{ url: string; discordMessageId: string; discordChannelId: string }> = [];

// Cache of real Discord channels for synthetic messages loaded from database
const channelCache = new Map<string, TextChannel>();

const backfillService = new BackfillService({
  repository,
  logger,
  embedder: embeddingProvider,
  summarizer: llmClient,
  youtubeClient,
});

const ingestionService = new IngestionService({
  repository,
  extractor: new ArticleExtractorContentExtractor(),
  pdfExtractor: new PdfContentExtractor(),
  fileExtractor: new FileContentExtractor(),
  summarizer: llmClient,
  embedder: embeddingProvider,
  logger,
  successReaction: config.INGEST_SUCCESS_REACTION,
  failureReaction: config.INGEST_FAILURE_REACTION,
  updateReaction: config.INGEST_UPDATE_REACTION,
  youtubeClient,
  ann: {
    collection: config.QDRANT_COLLECTION,
    indexBatch: (collection, items) => qdrantStore.indexBatch(collection, items),
  },
  onProgress: async (update, overall, messageId?: string) => {
    try {
      // Find the status message using the message ID from the first URL if available
      let statusMsg: Message | undefined;
      for (const [key, msg] of statusMessages) {
        if (overall.urls.includes(key) || key === messageId) {
          statusMsg = msg;
          break;
        }
      }
      if (!statusMsg) return;

      const content = formatProgressMessage(update, overall);

      // Only edit if the content changed
      if (statusMsg.content !== content) {
        await statusMsg.edit(content);
      }

      // When processing is complete, delete status message and send final summary as new message
      if (update.current === update.total && (update.phase === "completed" || update.phase === "failed")) {
        // Delete the progress status message
        try {
          await statusMsg.delete();
        } catch (err) {
          // Message might already be deleted, ignore error
        }

        // Send final summary as a new message
        let finalContent: string;
        if (update.phase === "completed" && update.summary) {
          const title = update.title || "Untitled";
          let summary = update.summary;
          // Make title a clickable link to the original article
          const titleLink = `[${title}](${update.url})`;
          // Truncate summary if needed
          const reservedSpace = 50;
          if (summary.length > 2000 - reservedSpace - title.length) {
            summary = summary.slice(0, 2000 - reservedSpace - title.length - 3) + "...";
          }
          // Use update icon for updated documents, tick for new documents
          const icon = update.isUpdate ? "🔄" : "✅";
          finalContent = `${icon} ${titleLink}\n\n${summary}`;
        } else if (update.phase === "failed") {
          finalContent = `❌ Failed to process <${update.url}>\n   Error: ${update.message || "Unknown error"}`;
        } else {
          finalContent = content;
        }

        // Add summary line for multi-URL runs
        if (overall.urls.length > 1) {
          const summary = overall.failed > 0
            ? `\n\n📊 Final: ${overall.completed} succeeded, ${overall.failed} failed`
            : `\n\n✅ All ${overall.completed} URLs processed successfully`;
          finalContent += summary;
        }

        await statusMsg.channel.send(finalContent);

        // Remove all entries that reference these URLs
        for (const [key] of statusMessages) {
          if (overall.urls.includes(key) || key === messageId) {
            statusMessages.delete(key);
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to update progress message", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
});

// Helper function to format queue status message
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

// Send startup/online notifications to channels we previously notified on shutdown
async function sendStartupNotifications(): Promise<void> {
  try {
    logger.info("Sending startup notifications to channels");

    // Build set of channel IDs to notify
    const channelIds = new Set<string>();
    for (const [, msg] of statusMessages) {
      try { if (msg.channelId) channelIds.add(msg.channelId); } catch (err) {}
    }
    for (const [channelId] of queueStatusMessages) {
      try { if (channelId) channelIds.add(channelId); } catch (err) {}
    }
    for (const [channelId] of channelCache) {
      channelIds.add(channelId);
    }

    const onlineMessage = "✅ Bot is back online — processing resumed";
    const notifyPromises: Promise<void>[] = [];

    if (channelIds.size === 0) {
      logger.debug("No channels found to send startup notification; attempting fallback");
      const fallbackChannelId = process.env.MAINTENANCE_NOTIFICATION_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
      if (fallbackChannelId) {
        try {
          const fetched = await bot.getClient().channels.fetch(fallbackChannelId);
          if (fetched && fetched.isText()) {
            const textChan = fetched as TextChannel;
            channelCache.set(fallbackChannelId, textChan);
            notifyPromises.push((async () => {
              try {
                await textChan.send(onlineMessage);
                logger.debug("Posted startup notification (fallback)", { channelId: fallbackChannelId });
              } catch (err) {
                logger.warn("Failed to post startup notification (fallback)", { channelId: fallbackChannelId, error: err instanceof Error ? err.message : String(err) });
              }
            })());
          } else {
            logger.warn("Fallback channel is not a text channel or could not be fetched", { fallbackChannelId });
          }
        } catch (err) {
          logger.warn("Failed to fetch fallback channel for startup notification", { fallbackChannelId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    for (const channelId of channelIds) {
      const cached = channelCache.get(channelId);
      if (cached) {
        notifyPromises.push((async () => {
          try {
            await cached.send(onlineMessage);
            logger.debug("Posted startup notification", { channelId });
          } catch (err) {
            logger.warn("Failed to post startup notification", { channelId, error: err instanceof Error ? err.message : String(err) });
          }
        })());
        continue;
      }

      notifyPromises.push((async () => {
        try {
          const fetched = await bot.getClient().channels.fetch(channelId);
          if (!fetched || !fetched.isText()) {
            logger.warn("Could not fetch text channel for startup notification", { channelId });
            return;
          }
          const textChan = fetched as TextChannel;
          channelCache.set(channelId, textChan);
          await textChan.send(onlineMessage);
          logger.debug("Posted startup notification", { channelId });
        } catch (err) {
          logger.warn("Failed to post startup notification", { channelId, error: err instanceof Error ? err.message : String(err) });
        }
      })());
    }

    await Promise.allSettled(notifyPromises);
    logger.info("Startup notifications complete");
  } catch (err) {
    logger.warn("Failed to send startup notifications", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Initialize crawl service
const crawlService = new CrawlService({
  logger,
  maxUrls: 20, // Limit to 20 URLs per crawl
  maxDepth: 1, // Only crawl the seed page (depth 0) and links from it (depth 1)
  requestDelayMs: config.CRAWL_DELAY_MS,
});

// Create queue repository for persistence
const queueRepository = new DocumentQueueRepository(getDbPool());

// Create the document queue to ensure sequential processing
const documentQueue = new DocumentQueue({
  logger,
  ingestionService,
  repository: queueRepository,
  onQueueUpdate: async (item, queueSize, status) => {
    try {
      const channelId = item.message.channelId;
      
      // Use cached channel if available (for synthetic messages loaded from DB)
      // otherwise use the real channel from the message
      let textChannel: TextChannel;
      const cachedChannel = channelCache.get(channelId);
      if (cachedChannel) {
        textChannel = cachedChannel;
      } else {
        if (item.message.channel.type !== 'GUILD_TEXT') return;
        textChannel = item.message.channel as TextChannel;
      }

      // Delete previous queue status message if it exists
      const previousMsg = queueStatusMessages.get(channelId);
      if (previousMsg) {
        try {
          await previousMsg.delete();
        } catch (err) {
          // Message might already be deleted, ignore error
        }
        queueStatusMessages.delete(channelId);
      }

      // When processing starts, always create a separate progress message
      // This happens regardless of queue size
      if (status === 'processing') {
        // Create a new status message for progress tracking
        // This will be used by the onProgress callback
        const statusMsg = await textChannel.send(`⏳ Processing <${item.url}>...`);
        // Store by message ID so onProgress can find it
        statusMessages.set(item.message.id, statusMsg);
      }

      // If queue is empty, don't post a new queue status message
      if (queueSize === 0) {
        return;
      }

      // Send queue status message (this stays visible)
      const messageContent = formatQueueMessage(item.url, queueSize, status);

      // Send new queue status message
      const newQueueMsg = await textChannel.send(messageContent);
      queueStatusMessages.set(channelId, newQueueMsg);
    } catch (err) {
      logger.warn("Failed to update queue status message", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // Enable polling for externally-added DB queue entries every 5s by default
  , pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 5000)
});

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
  onInteraction: async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

  if (commandName === "stats") {
      await interaction.deferReply();

      try {
        const stats = await repository.getStats();

        // Get pending queue count from DB (external + in-memory)
        let dbQueueCount = 0;
        try {
          dbQueueCount = await queueRepository.getPendingCount();
        } catch (err) {
          logger.warn("Failed to get DB queue count", { error: err instanceof Error ? err.message : String(err) });
        }

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
              name: "⏳ Queue Length (in-memory)",
              value: documentQueue.getQueueSize().toString(),
              inline: true
            },
            {
              name: "📥 Pending (DB)",
              value: dbQueueCount.toString(),
              inline: true
            },
            {
              name: "📐 Avg Embedding Dim",
              value: stats.averageEmbeddingDimensions.toFixed(0),
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
  },
  onMonitoredMessage: async (message) => {
    if (isLikelyContentQuery(message.content)) {
      try {
        const reply = await queryService.answerQuery(message.content);
        if (reply) {
          await message.reply(reply);
        }
      } catch (error) {
        logger.error("Failed to answer semantic query", {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id
    });

    // Check for crawl command
    if (crawlService.isCrawlCommand(message.content)) {
      logger.info("Crawl command detected", { messageId: message.id });

      // Extract the seed URL to show consistently throughout the crawl
      const seedUrl = extractCrawlSeedUrl(message.content);
      if (!seedUrl) {
        await message.channel.send("❌ Invalid crawl command. Usage: `crawl https://example.com`");
        return;
      }

      // Send initial crawl status
      const crawlStatusMsg = await message.channel.send("🔍 Starting crawl...");
      const discoveredUrlsList: string[] = [];

      try {
        // Create a temporary crawl service with progress callback
        const progressCrawlService = new CrawlService({
          logger,
          maxUrls: 20,
          maxDepth: 1,
          requestDelayMs: config.CRAWL_DELAY_MS,
          onProgress: async (progress) => {
            if (progress.phase === "crawling") {
              // Always show the seed URL at the start, not the current page being crawled
              let message = `🔍 Crawling <${seedUrl}>\n`;
              if (discoveredUrlsList.length > 0) {
                message += discoveredUrlsList.map((url, idx) => `${idx + 1}. <${url}>`).join("\n");
              }
              await crawlStatusMsg.edit(message);
            } else if (progress.phase === "discovered") {
              discoveredUrlsList.push(progress.url);
              // Build the message with updated list
              let message = `🔍 Crawling <${seedUrl}>\n`;
              message += discoveredUrlsList.map((url, idx) => `${idx + 1}. <${url}>`).join("\n");
              await crawlStatusMsg.edit(message);
            } else if (progress.phase === "complete") {
              // Final message with completion status
              let message = `🔍 Finished URL discovery\n`;
              if (discoveredUrlsList.length > 0) {
                message += discoveredUrlsList.map((url, idx) => `${idx + 1}. <${url}>`).join("\n");
              } else {
                message += "No URLs discovered";
              }
              await crawlStatusMsg.edit(message);
            }
          },
        });

        const result = await progressCrawlService.crawlFromMessage(message.content);

        if (!result) {
          await crawlStatusMsg.edit("❌ Invalid crawl command. Usage: `crawl https://example.com`");
          return;
        }

        if (result.discoveredUrls.length === 0) {
          await crawlStatusMsg.edit(`🔍 Crawl complete. No new URLs discovered from ${result.seedUrl}`);
          return;
        }

        // Add discovered URLs to queue as a batch
        await documentQueue.enqueueUrls(result.discoveredUrls, message);

        logger.info("Crawl discovered URLs added to queue", {
          messageId: message.id,
          discoveredCount: result.discoveredUrls.length,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Crawl failed", { messageId: message.id, error: errorMessage });
        await crawlStatusMsg.edit(`❌ Crawl failed: ${errorMessage}`);
      }
      return;
    }

    // Add message to queue for sequential processing
    // Queue status will be handled by onQueueUpdate callback
    await documentQueue.enqueue(message);
    
    // Save checkpoint after successful enqueue
    // This ensures we know which message was last processed for startup recovery
    try {
      await repository.saveCheckpoint(config.DISCORD_CHANNEL_ID, message.id);
      logger.debug("Checkpoint saved", { messageId: message.id });
    } catch (error) {
      logger.error("Failed to save checkpoint", {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - checkpoint failure shouldn't stop message processing
    }
  }
});

// Perform startup recovery to catch up on missed messages
async function performStartupRecovery(): Promise<void> {
  logger.info("Starting startup recovery for missed messages");
  
  try {
    const recoveryService = new StartupRecoveryService({
      discordClient: bot.getClient(),
      repository,
      documentQueue,
      logger,
      channelId: config.DISCORD_CHANNEL_ID,
      maxMessages: config.STARTUP_RECOVERY_MAX_MESSAGES,
    });

    const result = await recoveryService.performRecovery();

    logger.info("Startup recovery completed", {
      messagesProcessed: result.messagesProcessed,
      messagesSkipped: result.messagesSkipped,
      urlsFound: result.urlsFound,
      urlsQueued: result.urlsQueued,
      oldestMessageId: result.oldestMessageId,
      newestMessageId: result.newestMessageId,
    });
  } catch (error) {
    logger.error("Startup recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - we don't want recovery failures to prevent the bot from starting
  }
}
async function startBot() {
  try {
    // Load any pending items from database
    pendingItemsFromRestart = await documentQueue.initialize();
    
    // Start the bot
    await bot.start();
    
    // After bot starts and is connected, perform startup recovery
    // to catch up on messages missed during downtime
    if (config.STARTUP_RECOVERY_MAX_MESSAGES > 0) {
      await performStartupRecovery();
    }
    
    // After bot starts, restore status message tracking for pending items
    if (pendingItemsFromRestart.length > 0) {
      await restoreStatusMessages();
    }

    // Send startup notifications to channels (if any)
    await sendStartupNotifications();

    // Start periodic backfill queue processing (re-embed/update existing links)
    backfillService.startPeriodicProcessing(config.BACKFILL_INTERVAL_MS);
  } catch (error) {
    logger.error("Bot startup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}

// Restore status message tracking after bot restart
async function restoreStatusMessages(): Promise<void> {
  logger.info("Restoring status message tracking for pending items", {
    count: pendingItemsFromRestart.length,
  });

  // Group items by channel to send one queue status message per channel
  const itemsByChannel = new Map<string, typeof pendingItemsFromRestart>();
  for (const item of pendingItemsFromRestart) {
    const existing = itemsByChannel.get(item.discordChannelId) || [];
    existing.push(item);
    itemsByChannel.set(item.discordChannelId, existing);
  }

  // Fetch and cache real Discord channels, then send queue status messages
  for (const [channelId, items] of itemsByChannel) {
    try {
      const channel = await bot.getClient().channels.fetch(channelId);
      if (!channel || !channel.isText()) {
        logger.warn("Could not find channel for pending items", {
          channelId,
        });
        continue;
      }

      // Cache the real channel for later use by onQueueUpdate
      channelCache.set(channelId, channel as TextChannel);

      // Send a single queue status message showing queue length
      const queueSize = items.length;
      const messageContent = `⚙️ Resuming processing of ${queueSize} item${queueSize > 1 ? 's' : ''} from queue`;
      const queueMsg = await (channel as TextChannel).send(messageContent);
      queueStatusMessages.set(channelId, queueMsg);

      logger.debug("Restored queue status message", {
        channelId,
        queueSize,
      });
    } catch (err) {
      logger.warn("Failed to restore queue status message", {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue with other channels - don't let one failure stop the rest
    }
  }

  logger.info("Status message restoration complete", {
    channelsRestored: queueStatusMessages.size,
    channelsCached: channelCache.size,
  });
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
    // Log counts for debugging why notifications may not be sent
    logger.debug("Shutdown notification sources", {
      statusMessages: statusMessages.size,
      queueStatusMessages: queueStatusMessages.size,
      channelCache: channelCache.size,
    });

    // Build a set of channel IDs we should notify. Prefer real TextChannel instances
    // from the cache or message objects; otherwise we'll attempt to fetch the channel.
    const channelIds = new Set<string>();
    for (const [, msg] of statusMessages) {
      try {
        if (msg.channelId) channelIds.add(msg.channelId);
      } catch (err) {}
    }
    for (const [channelId] of queueStatusMessages) {
      try {
        if (channelId) channelIds.add(channelId);
      } catch (err) {}
    }
    for (const [channelId] of channelCache) {
      channelIds.add(channelId);
    }

    const maintenanceMessage = "🔄 Bot Closing Down for Maintenance - Processing will resume shortly";
    const notificationPromises: Promise<void>[] = [];

    if (channelIds.size === 0) {
      logger.debug("No active channels discovered for shutdown notification");
      // Fallback to a configured notification channel or the monitored channel
      const fallbackChannelId = process.env.MAINTENANCE_NOTIFICATION_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
      if (fallbackChannelId) {
        logger.debug("Attempting fallback notification channel", { fallbackChannelId });
        try {
          const fetched = await bot.getClient().channels.fetch(fallbackChannelId);
          if (fetched && fetched.isText()) {
            const textChan = fetched as TextChannel;
            channelCache.set(fallbackChannelId, textChan);
            notificationPromises.push((async () => {
              try {
                await textChan.send(maintenanceMessage);
                logger.debug("Posted maintenance notification (fallback)", { channelId: fallbackChannelId });
              } catch (err) {
                logger.warn("Failed to post maintenance notification (fallback)", { channelId: fallbackChannelId, error: err instanceof Error ? err.message : String(err) });
              }
            })());
          } else {
            logger.warn("Fallback channel is not a text channel or could not be fetched", { fallbackChannelId });
          }
        } catch (err) {
          logger.warn("Failed to fetch fallback notification channel", { fallbackChannelId, error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        logger.debug("No fallback channel configured for shutdown notifications");
      }
    }

    for (const channelId of channelIds) {
      // Use cached TextChannel if available
      const cached = channelCache.get(channelId);
      if (cached) {
        notificationPromises.push((async () => {
          try {
            await cached.send(maintenanceMessage);
            logger.debug("Posted maintenance notification", { channelId });
          } catch (err) {
            logger.warn("Failed to post maintenance notification", { channelId, error: err instanceof Error ? err.message : String(err) });
          }
        })());
        continue;
      }

      // Not cached: attempt to fetch channel from Discord client
      notificationPromises.push((async () => {
        try {
          const fetched = await bot.getClient().channels.fetch(channelId);
          if (!fetched || !fetched.isText()) {
            logger.warn("Could not fetch text channel for maintenance notification", { channelId });
            return;
          }

          const textChan = fetched as TextChannel;
          // Cache for later use during shutdown
          channelCache.set(channelId, textChan);

          await textChan.send(maintenanceMessage);
          logger.debug("Posted maintenance notification", { channelId });
        } catch (err) {
          logger.warn("Failed to post maintenance notification", { channelId, error: err instanceof Error ? err.message : String(err) });
        }
      })());
    }
    
    // Wait for notifications to complete (with timeout)
    await Promise.race([
      Promise.all(notificationPromises),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
    ]).catch(err => {
      logger.warn("Some maintenance notifications timed out", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Delete or update progress status messages
    const progressCleanupPromises: Promise<void>[] = [];
    for (const [key, msg] of statusMessages) {
      progressCleanupPromises.push(
        (async () => {
          try {
            await msg.edit("⏸️ Processing paused - bot restarting");
            logger.debug("Updated progress status message", { key });
          } catch (err) {
            // Try to delete if edit fails
            try {
              await msg.delete();
              logger.debug("Deleted progress status message", { key });
            } catch (deleteErr) {
              logger.warn("Failed to cleanup progress message", {
                key,
                error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
              });
            }
          }
        })()
      );
    }
    
    // Delete queue status messages
    const queueCleanupPromises: Promise<void>[] = [];
    for (const [channelId, msg] of queueStatusMessages) {
      queueCleanupPromises.push(
        (async () => {
          try {
            await msg.edit("⏸️ Queue processing paused - bot restarting");
            logger.debug("Updated queue status message", { channelId });
          } catch (err) {
            // Try to delete if edit fails
            try {
              await msg.delete();
              logger.debug("Deleted queue status message", { channelId });
            } catch (deleteErr) {
              logger.warn("Failed to cleanup queue message", {
                channelId,
                error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
              });
            }
          }
        })()
      );
    }

    // Wait for message cleanup with timeout
    await Promise.race([
      Promise.all([...progressCleanupPromises, ...queueCleanupPromises]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
    ]).catch(err => {
      logger.warn("Some message cleanup timed out", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Re-queue current processing item if any
    // Stop background polling to avoid creating new items while shutting down
    try {
      documentQueue.stopPolling();
      logger.debug("Stopped document queue polling for shutdown");
    } catch (err) {
      logger.warn("Failed to stop document queue polling", { error: err instanceof Error ? err.message : String(err) });
    }
    const currentItem = documentQueue.getCurrentItem();
    if (currentItem) {
      logger.info("Re-queuing current processing item", {
        url: currentItem.url,
      });
      documentQueue.requeueCurrentItem();
    }

    // Close database connection
    logger.info("Closing database connection...");
    try {
      await closeDbPool();
      logger.info("Database connection closed successfully");
    } catch (err) {
      logger.error("Failed to close database connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during graceful shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

startBot();
