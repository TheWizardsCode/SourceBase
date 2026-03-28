import { cliConfig as config } from "../../config/cli.js";
import { getDbPool } from "../../db/client.js";
import { DocumentQueueRepository } from "../../db/queue-repository.js";

interface CliContext {
  channelId?: string;
  messageId?: string;
  authorId?: string;
}

interface QueueOptions {
  verbose?: boolean;
  context?: CliContext;
}

interface QueueResult {
  success: boolean;
  url: string;
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

async function queueSingleUrl(url: string, options: QueueOptions): Promise<QueueResult> {
  try {
    const pool = getDbPool();
    const repository = new DocumentQueueRepository(pool);
    
    // Create a queue entry with source context (CLI or Discord)
    // Use context from CLI flags if provided, otherwise use defaults
    const entry = await repository.create({
      url,
      sourceId: options.context?.messageId || `cli-${Date.now()}`,
      sourceContext: options.context?.channelId || "cli",
      authorId: options.context?.authorId || "cli-user"
    });
    
    return {
      success: true,
      url,
      id: entry.id
    };
  } catch (error) {
    return {
      success: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function queueCommand(urls: string[], options: QueueOptions = {}): Promise<{ results: QueueResult[]; exitCode: number }> {
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
  const results: QueueResult[] = [];
  let hasFailure = false;
  
  for (let i = 0; i < validUrls.length; i++) {
    const url = validUrls[i];
    
    if (options.verbose) {
      console.log(`Queueing: ${url}`);
    }
    
    const result = await queueSingleUrl(url, options);
    results.push(result);
    
    if (result.success) {
      console.log(`Queued: ${url}${result.id ? ` (ID: ${result.id})` : ""}`);
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
