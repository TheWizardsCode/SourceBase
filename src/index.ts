import type { Message } from "discord.js";
import { config } from "./config.js";
import { getDbPool } from "./db/client.js";
import { LinkRepository } from "./db/repository.js";
import { DiscordBot } from "./discord/client.js";
import { ArticleExtractorContentExtractor } from "./ingestion/extractor.js";
import { IngestionService } from "./ingestion/service.js";
import type { ProgressUpdate, IngestionProgress, ProgressPhase } from "./ingestion/service.js";
import { DocumentQueue } from "./ingestion/queue.js";
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
    storing: "💾",
    completed: "✅",
    failed: "❌"
  };

  const phaseLabel: Record<ProgressPhase, string> = {
    downloading: "Downloading",
    extracting_links: "Extracting",
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
    // Reserve space for emoji, counter, title, queue info, and newlines
    const reservedSpace = 150;
    if (summary.length > 2000 - reservedSpace - title.length) {
      summary = summary.slice(0, 2000 - reservedSpace - title.length - 3) + "...";
    }
    
    let result = `${emoji} ${progressCounter}${title}\n\n${summary}`;
    
    // Add queue size indicator if there are more items in queue
    if (update.queueSize && update.queueSize > 0) {
      result += `\n\n📋 ${update.queueSize} more in queue`;
    }
    
    return result;
  }

  let message = `${emoji} ${progressCounter}${label}: <${update.url}>`;

  if (update.phase === "failed" && update.message) {
    message += `\n   Error: ${update.message}`;
  }

  if (isMultiUrl && (update.phase === "completed" || update.phase === "failed")) {
    const completed = overall.completed;
    const failed = overall.failed;
    const total = overall.urls.length;
    message += `\n   Progress: ${completed} succeeded, ${failed} failed (${completed + failed}/${total})`;
  }

  // Add queue size indicator if there are more items in queue
  if (update.queueSize && update.queueSize > 0) {
    message += `\n📋 ${update.queueSize} more in queue`;
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

const ingestionService = new IngestionService({
  repository,
  extractor: new ArticleExtractorContentExtractor(),
  summarizer: llmClient,
  embedder: embeddingProvider,
  logger,
  successReaction: config.INGEST_SUCCESS_REACTION,
  failureReaction: config.INGEST_FAILURE_REACTION,
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

      // Clean up status message tracking when done
      if (update.current === update.total && (update.phase === "completed" || update.phase === "failed")) {
        // Add summary line for multi-URL runs
        if (overall.urls.length > 1) {
          const summary = overall.failed > 0
            ? `\n\n📊 Final: ${overall.completed} succeeded, ${overall.failed} failed`
            : `\n\n✅ All ${overall.completed} URLs processed successfully`;
          const queueInfo = update.queueSize && update.queueSize > 0 ? `\n📋 ${update.queueSize} more in queue` : "";
          await statusMsg.edit(content + summary + queueInfo);
        } else if (update.queueSize && update.queueSize > 0) {
          // Add queue info for single URL runs too
          await statusMsg.edit(content + `\n\n📋 ${update.queueSize} more in queue`);
        }
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

// Create the document queue to ensure sequential processing
const documentQueue = new DocumentQueue({
  logger,
  ingestionService
});

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
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

    // Create a status message for progress reporting
    const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
    if (urls.length > 0 && message.channel.type === 'GUILD_TEXT') {
      const queueSize = documentQueue.getQueueSize();
      const queueInfo = queueSize > 0 ? ` (${queueSize} ahead in queue)` : "";
      const statusMsg = await message.channel.send(`⏳ Queued ${urls.length} URL${urls.length > 1 ? 's' : ''}${queueInfo}...`);
      statusMessages.set(message.id, statusMsg);
    }

    // Add message to queue for sequential processing
    documentQueue.enqueue(message);
  }
});

bot.start().catch((error) => {
  logger.error("Bot startup failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
