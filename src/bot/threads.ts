import { ThreadChannel, type Message } from "discord.js";
import type { Logger } from "../log/index.js";

/**
 * Format thread name for URL processing
 */
export function formatThreadName(url: string): string {
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
 * Create a thread for a given message with fallbacks.
 * Tries message.startThread(), then channel.threads.create() (with and without startMessage).
 * Returns the created ThreadChannel or null if thread creation is not supported / failed.
 */
export async function createThreadForMessage(
  message: Message,
  name: string,
  autoArchiveDuration = 60,
  logger?: Logger
): Promise<ThreadChannel | null> {
  try {
    // Prefer the Message#startThread API when available
    const startThreadFn = (message as any).startThread;
    if (typeof startThreadFn === "function") {
      try {
        const t = await startThreadFn.call(message, { name, autoArchiveDuration });
        logger?.info("Created thread with message.startThread", {
          messageId: message.id,
          threadId: (t as any)?.id,
        });
        return t as ThreadChannel;
      } catch (err) {
        logger?.warn("message.startThread failed", {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: channel.threads.create()
    const chAny = message.channel as any;
    if (chAny && chAny.threads && typeof chAny.threads.create === "function") {
      try {
        // Try with startMessage (preferred) then without if it fails
        try {
          const t = await chAny.threads.create({
            name,
            autoArchiveDuration,
            startMessage: message.id,
          });
          logger?.info("Created thread with channel.threads.create (with startMessage)", {
            messageId: message.id,
            threadId: (t as any)?.id,
          });
          return t as ThreadChannel;
        } catch (err) {
          logger?.warn("channel.threads.create with startMessage failed, trying without startMessage", {
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
          const t2 = await chAny.threads.create({ name, autoArchiveDuration });
          logger?.info("Created thread with channel.threads.create (without startMessage)", {
            messageId: message.id,
            threadId: (t2 as any)?.id,
          });
          return t2 as ThreadChannel;
        }
      } catch (err) {
        logger?.warn("channel.threads.create failed", {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger?.warn("Unhandled error while attempting to create thread", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}
