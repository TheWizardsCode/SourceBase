import { config } from "./config.js";
import { getDbPool } from "./db/client.js";
import { LinkRepository } from "./db/repository.js";
import { DiscordBot } from "./discord/client.js";
import { ArticleExtractorContentExtractor } from "./ingestion/extractor.js";
import { IngestionService } from "./ingestion/service.js";
import { YouTubeApiClient } from "./ingestion/youtube.js";
import { OpenAiCompatibleLlmClient } from "./llm/client.js";
import { OpenAiCompatibleEmbeddingProvider } from "./llm/embeddings.js";
import { Logger } from "./logger.js";
import { isLikelyContentQuery } from "./query/detector.js";
import { QueryService } from "./query/service.js";

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

const ingestionService = new IngestionService({
  repository,
  extractor: new ArticleExtractorContentExtractor(),
  summarizer: llmClient,
  embedder: embeddingProvider,
  logger,
  successReaction: config.INGEST_SUCCESS_REACTION,
  failureReaction: config.INGEST_FAILURE_REACTION,
  youtubeClient
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

    await ingestionService.ingestMessage(message);
  }
});

bot.start().catch((error) => {
  logger.error("Bot startup failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
