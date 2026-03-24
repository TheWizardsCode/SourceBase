import type { Message } from "discord.js";
import { config } from "./config.js";
import { getDbPool } from "./db/client.js";
import { LinkRepository } from "./db/repository.js";
import { DocumentQueueRepository } from "./db/queue-repository.js";
import { DiscordBot } from "./discord/client.js";
import { ArticleExtractorContentExtractor } from "./ingestion/extractor.js";
import { IngestionService } from "./ingestion/service.js";
import type { ProgressUpdate, IngestionProgress, ProgressPhase } from "./ingestion/service.js";
import { DocumentQueue, type QueueUpdateStatus } from "./ingestion/queue.js";
import { CrawlService } from "./ingestion/crawl.js";
import { extractCrawlSeedUrl } from "./ingestion/url.js";
import { YouTubeApiClient } from "./ingestion/youtube.js";
import { OpenAiCompatibleLlmClient } from "./llm/client.js";
import { OpenAiCompatibleEmbeddingProvider } from "./llm/embeddings.js";
import { Logger } from "./logger.js";
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
  maxRetries: config.LLM_MAX_RETRIES,
  retryDelayMs: config.LLM_RETRY_DELAY_MS
});
const embeddingProvider = new OpenAiCompatibleEmbeddingProvider(llmClient);
const queryService = new QueryService(repository, embeddingProvider);

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

const ingestionService = new IngestionService({
  repository,
  extractor: new ArticleExtractorContentExtractor(),
  summarizer: llmClient,
  embedder: embeddingProvider,
  logger,
  successReaction: config.INGEST_SUCCESS_REACTION,
  failureReaction: config.INGEST_FAILURE_REACTION,
  updateReaction: config.INGEST_UPDATE_REACTION,
  youtubeClient,
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
      if (item.message.channel.type !== 'GUILD_TEXT') return;

      const channelId = item.message.channelId;

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
        const statusMsg = await item.message.channel.send(`⏳ Processing <${item.url}>...`);
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
      const newQueueMsg = await item.message.channel.send(messageContent);
      queueStatusMessages.set(channelId, newQueueMsg);
    } catch (err) {
      logger.warn("Failed to update queue status message", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
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
  }
});

// Initialize the queue from database before starting
async function startBot() {
  try {
    // Load any pending items from database
    await documentQueue.initialize();
    
    // Start the bot
    await bot.start();
  } catch (error) {
    logger.error("Bot startup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}

startBot();
