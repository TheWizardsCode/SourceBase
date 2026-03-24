import { config } from "../../config.js";
import { getDbPool } from "../../db/client.js";
import { LinkRepository } from "../../db/repository.js";
import { ArticleExtractorContentExtractor } from "../../ingestion/extractor.js";
import { IngestionService, type ProgressUpdate, type IngestionProgress, type ProgressCallback } from "../../ingestion/service.js";
import { isYouTubeUrl } from "../../ingestion/url.js";
import { YouTubeApiClient } from "../../ingestion/youtube.js";
import { OpenAiCompatibleLlmClient } from "../../llm/client.js";
import { Logger } from "../../logger.js";

interface AddResult {
  success: boolean;
  url: string;
  title?: string;
  id?: number;
  error?: string;
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatProgressLine(phase: string, current: number, total: number, url: string): string {
  const phaseEmoji: Record<string, string> = {
    downloading: "⬇️ ",
    extracting_links: "📄",
    updating: "🔄",
    summarizing: "✍️ ",
    embedding: "🔢",
    storing: "💾",
    completed: "✅",
    failed: "❌"
  };
  
  const emoji = phaseEmoji[phase] || "⏳";
  const progress = total > 1 ? `[${current}/${total}] ` : "";
  const phaseLabel = phase.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  
  return `${emoji} ${progress}${phaseLabel}: ${url}`;
}

function createConsoleProgressCallback(): ProgressCallback {
  return async (update: ProgressUpdate, overall: IngestionProgress) => {
    const line = formatProgressLine(update.phase, update.current, update.total, update.url);
    
    // Clear previous line and print new status
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K");
      process.stdout.write(line);
      
      // Add newline on completion or failure
      if (update.phase === "completed" || update.phase === "failed") {
        process.stdout.write("\n");
      }
    } else {
      // Non-TTY: just print on phase changes
      if (update.phase !== "downloading") {
        console.log(line);
      }
    }
  };
}

async function processSingleUrl(
  url: string,
  ingestionService: IngestionService,
  logger: Logger
): Promise<AddResult> {
  try {
    // Use a mock message object for compatibility with IngestionService
    const mockMessage = {
      id: `cli-${Date.now()}`,
      content: url,
      channelId: "cli",
      author: { id: "cli-user" },
      client: { user: { id: "cli-bot" } },
      react: async () => {},
      reactions: {
        cache: { get: () => undefined },
        resolve: () => undefined
      }
    } as any;

    // Track the result
    let resultTitle: string | undefined;
    let resultId: number | undefined;
    let completed = false;
    let failed = false;
    let errorMsg: string | undefined;

    // Create progress callback that captures the result
    const progressCallback: ProgressCallback = async (update, overall) => {
      // Call console progress callback for display
      await createConsoleProgressCallback()(update, overall);
      
      // Capture result data
      if (update.phase === "completed") {
        resultTitle = update.title;
        completed = true;
      } else if (update.phase === "failed") {
        failed = true;
        errorMsg = update.message;
      }
    };

    // Create a custom ingestion service with our progress callback
    // We need to create a new service because onProgress is passed in constructor options
    const pool = getDbPool();
    const repository = new LinkRepository(pool);
    const extractor = new ArticleExtractorContentExtractor();
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
      summarizer: llmClient,
      embedder: llmClient,
      logger,
      successReaction: config.INGEST_SUCCESS_REACTION,
      failureReaction: config.INGEST_FAILURE_REACTION,
      updateReaction: config.INGEST_UPDATE_REACTION,
      youtubeClient,
      onProgress: progressCallback
    });

    await customService.ingestMessage(mockMessage);

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

export async function addCommand(urls: string[]): Promise<{ results: AddResult[]; exitCode: number }> {
  const logger = new Logger(config.LOG_LEVEL);
  
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
  
  // Report invalid URLs
  if (invalidUrls.length > 0) {
    for (const url of invalidUrls) {
      console.error(`⚠️ Invalid URL: ${url}`);
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
    
    // Print URL being processed
    if (validUrls.length > 1) {
      console.log(`\n[${i + 1}/${validUrls.length}] Processing: ${url}`);
    }
    
    const result = await processSingleUrl(url, null as any, logger);
    results.push(result);
    
    if (result.success) {
      const title = result.title || url;
      console.log(`✅ Added: ${title}${result.id ? ` (ID: ${result.id})` : ""}`);
    } else {
      console.error(`⚠️ Failed: ${url} - ${result.error}`);
      hasFailure = true;
    }
  }
  
  return {
    results,
    exitCode: hasFailure ? 1 : 0
  };
}
