import { cliConfig as config } from "../../config/cli.js";
import { getDbPool } from "../../db/client.js";
import { LinkRepository } from "../../db/repository.js";
import { ArticleExtractorContentExtractor, FileContentExtractor } from "../../ingestion/extractor.js";
import { IngestionService, type ProgressUpdate, type IngestionProgress, type ProgressCallback } from "../../ingestion/service.js";
import { YouTubeApiClient } from "../../ingestion/youtube.js";
import { OpenAiCompatibleLlmClient } from "../../llm/client.js";
import { Logger } from "../../logger.js";
import { getQdrantVectorStore } from "../../vector/qdrant-store.js";
import {
  createProgressPresenter,
  toCliProgressEvent,
  type CliProgressPresenter,
  type PresenterFormat,
} from "../presenters/index.js";

interface AddOptions {
  verbose?: boolean;
  format?: PresenterFormat;
  webhookUrl?: string;
}

interface AddResult {
  success: boolean;
  url: string;
  title?: string;
  id?: number;
  error?: string;
}

class SilentLogger extends Logger {
  constructor() {
    super("error"); // Only log errors, which we won't produce
  }
  
  // Override all methods to do nothing
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}

async function processSingleUrl(
  url: string,
  options: AddOptions
): Promise<AddResult> {
  try {
    // Create a SyntheticMessage for CLI usage (no Discord dependencies)
    const syntheticMessage = {
      id: `cli-${Date.now()}`,
      content: url,
      channelId: "cli",
      authorId: "cli-user",
    };

    // Track the result
    let resultTitle: string | undefined;
    let resultId: number | undefined;
    let completed = false;
    let failed = false;
    let errorMsg: string | undefined;

    // Create progress presenter based on options
    const presenter: CliProgressPresenter = createProgressPresenter({
      format: options.format,
      webhookUrl: options.webhookUrl,
    });

    // Create progress callback that captures the result and delegates to presenter
    const progressCallback: ProgressCallback = async (update, overall) => {
      // Convert to CLI progress event and send to presenter
      const event = toCliProgressEvent(update, overall);
      await presenter.onProgress(event);
      
      // Capture result data
      if (update.phase === "completed") {
        resultTitle = update.title;
        completed = true;
      } else if (update.phase === "failed") {
        failed = true;
        errorMsg = update.message;
      }
    };

    // Create logger - silent unless verbose (suppresses JSON logging from ingestion service)
    const logger = options.verbose ? new Logger(config.LOG_LEVEL) : new SilentLogger();

    // Create a custom ingestion service with our progress callback
    const pool = getDbPool();
    const repository = new LinkRepository(pool);
    const extractor = new ArticleExtractorContentExtractor();
    const fileExtractor = new FileContentExtractor();
    const llmClient = new OpenAiCompatibleLlmClient({
      baseUrl: config.LLM_BASE_URL,
      model: config.LLM_MODEL,
      maxRetries: config.LLM_MAX_RETRIES,
      retryDelayMs: config.LLM_RETRY_DELAY_MS
    });
    
    const youtubeClient = config.ENABLE_YOUTUBE_CAPTIONS && config.YOUTUBE_API_KEY 
      ? new YouTubeApiClient(logger, config.YOUTUBE_API_KEY)
      : undefined;

    const customService = new IngestionService({
      repository,
      extractor,
      fileExtractor,
      summarizer: llmClient,
      embedder: llmClient,
      logger,
      successReaction: config.INGEST_SUCCESS_REACTION,
      failureReaction: config.INGEST_FAILURE_REACTION,
      updateReaction: config.INGEST_UPDATE_REACTION,
      youtubeClient,
      ann: {
        collection: config.QDRANT_COLLECTION,
        indexBatch: (collection, items) => getQdrantVectorStore().indexBatch(collection, items),
      },
      onProgress: progressCallback
    });

    await customService.ingestMessage(syntheticMessage);

    if (completed) {
      // Get the stored link to retrieve the ID
      const stored = await repository.getLinkByUrl?.(url);
      return {
        success: true,
        url,
        title: resultTitle,
        id: stored?.id
      };
    } else if (failed) {
      return {
        success: false,
        url,
        error: errorMsg || "Unknown error during ingestion"
      };
    } else {
      return {
        success: false,
        url,
        error: "Processing did not complete"
      };
    }
  } catch (error) {
    return {
      success: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function addCommand(urls: string[], options: AddOptions = {}): Promise<{ results: AddResult[]; exitCode: number }> {
  // Validate all URLs first
  const invalidUrls: string[] = [];
  const validUrls: string[] = [];
  
  for (const url of urls) {
    if (!validateUrl(url)) {
      invalidUrls.push(url);
    } else {
      validUrls.push(url);
    }
  }
  
  // Report invalid URLs (always show these errors)
  if (invalidUrls.length > 0) {
    for (const url of invalidUrls) {
      console.error(`Invalid URL: ${url}`);
    }
  }
  
  // If no valid URLs, exit early
  if (validUrls.length === 0) {
    console.error("Error: No valid URLs provided");
    return { results: [], exitCode: 1 };
  }
  
  // Process each URL
  const results: AddResult[] = [];
  let hasFailure = false;
  
  for (let i = 0; i < validUrls.length; i++) {
    const url = validUrls[i];
    
    const result = await processSingleUrl(url, options);
    results.push(result);
    
    if (result.success) {
      const title = result.title || url;
      console.log(`Added: ${title}${result.id ? ` (ID: ${result.id})` : ""}`);
    } else {
      console.error(`Failed: ${url} - ${result.error}`);
      hasFailure = true;
    }
  }
  
  return {
    results,
    exitCode: hasFailure ? 1 : 0
  };
}
