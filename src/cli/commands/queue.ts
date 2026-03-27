import { botConfig as config } from "../../config/bot.js";
import { getDbPool } from "../../db/client.js";
import { DocumentQueueRepository } from "../../db/queue-repository.js";

interface QueueOptions {
  verbose?: boolean;
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

async function queueSingleUrl(url: string): Promise<QueueResult> {
  try {
    const pool = getDbPool();
    const repository = new DocumentQueueRepository(pool);
    
    // Create a queue entry with real Discord channel ID for notifications
    const entry = await repository.create({
      url,
      discordMessageId: `cli-${Date.now()}`,
      discordChannelId: config.DISCORD_CHANNEL_ID,
      discordAuthorId: "cli-user"
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
    
    const result = await queueSingleUrl(url);
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
