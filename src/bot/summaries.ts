import { ThreadChannel, type Message } from "discord.js";
import type { Logger } from "../log/index.js";
import { botConfig as config } from "../config/bot.js";
import {
  DISCORD_CONTENT_LIMIT,
  extractSummaryFromMarkdown,
} from "../presenters/discordFormatting.js";
import { ProgressPresenter } from "../presenters/progress.js";
import { runSummaryCommand, type AddResult } from "./cli-runner.js";
import { sleep } from "./utils.js";
import { sendWithFallback } from "../presenters/QueuePresenter.js";

/**
 * Retry configuration for summary generation
 */
const SUMMARY_RETRY_ATTEMPTS = 3;
const SUMMARY_RETRY_BASE_DELAY_MS =
  process.env.NODE_ENV === "test" ? 1 : 500;

/**
 * Track posted summaries to avoid duplicates
 */
const postedSummaryMarkers = new Set<string>();
const manualReviewSummaryMarkers = new Set<string>();

/**
 * Target that can receive messages
 */
export interface SendableTarget {
  id: string;
  send: (content: string) => Promise<unknown>;
}

/**
 * Get marker key for a summary
 */
export function getSummaryMarker(url: string, itemId?: number): string {
  return itemId !== undefined ? `item:${itemId}` : `url:${url}`;
}

/**
 * Check if a summary has already been posted
 */
export function isSummaryPosted(url: string, itemId?: number): boolean {
  return postedSummaryMarkers.has(getSummaryMarker(url, itemId));
}

/**
 * Mark a summary as posted
 */
export function markSummaryPosted(url: string, itemId?: number): void {
  postedSummaryMarkers.add(getSummaryMarker(url, itemId));
  manualReviewSummaryMarkers.delete(getSummaryMarker(url, itemId));
}

/**
 * Build OpenBrain item link from template
 */
export function buildOpenBrainItemLink(
  itemId: number | undefined,
  sourceUrl: string
): string {
  const template = config.OPENBRAIN_ITEM_URL_TEMPLATE?.trim();

  if (!template) {
    return sourceUrl;
  }

  return template
    .replaceAll("{id}", itemId !== undefined ? String(itemId) : "")
    .replaceAll("{url}", encodeURIComponent(sourceUrl));
}

/**
 * Format a summary message with metadata
 */
export function formatSummaryMessage(params: {
  summary: string;
  itemId?: number;
  sourceUrl: string;
  authorId: string;
  timestamp?: string;
  itemLink: string;
}): string {
  const { summary, itemId, sourceUrl, authorId, timestamp, itemLink } = params;

  return [
    "🧾 OpenBrain summary",
    "",
    summary,
    "",
    `OpenBrain item: <${itemLink}>`,
    `Source URL: <${sourceUrl}>`,
    `Item ID: ${itemId !== undefined ? itemId : "unknown"}`,
    `Author: <@${authorId}>`,
    `Timestamp: ${timestamp || new Date().toISOString()}`,
  ].join("\n");
}

/**
 * Resolve the target for posting a summary
 */
export async function resolveSummaryTarget(
  message: Message,
  preferredThread: ThreadChannel | null,
  logger?: Logger
): Promise<SendableTarget | null> {
  if (preferredThread) {
    return preferredThread as unknown as SendableTarget;
  }

  const fallbackChannelId = config.DEFAULT_DISCORD_CHANNEL_ID?.trim();
  if (fallbackChannelId) {
    try {
      const fallbackChannel = await message.client.channels.fetch(fallbackChannelId);
      if (fallbackChannel && typeof (fallbackChannel as any).send === "function") {
        return fallbackChannel as unknown as SendableTarget;
      }

      logger?.warn("Configured default summary channel is not sendable", {
        channelId: fallbackChannelId,
        messageId: message.id,
      });
    } catch (error) {
      logger?.warn("Failed to resolve configured default summary channel", {
        channelId: fallbackChannelId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const chAny = (message.channel as any) || null;
  if (chAny && typeof chAny.send === "function") {
    return chAny as unknown as SendableTarget;
  }

  return null;
}

/**
 * Generate a summary with retry logic
 */
export async function generateSummaryWithRetry(
  url: string,
  context: {
    channelId: string;
    messageId: string;
    authorId: string;
    timeoutMs?: number;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
  },
  logger?: Logger
): Promise<{ success: true; summary: string } | { success: false; error: string }> {
  const maxAttempts = Math.max(1, context.maxAttempts ?? SUMMARY_RETRY_ATTEMPTS);
  const retryBaseDelayMs = Math.max(
    1,
    context.retryBaseDelayMs ?? SUMMARY_RETRY_BASE_DELAY_MS
  );
  let lastError = "Unknown summary generation error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runSummaryCommand(url, {
      ...context,
      timeoutMs: context.timeoutMs,
    });

    // Defensive: some tests/mocks may return undefined or non-object values.
    if (result && typeof result === "object" && result.success && result.summary) {
      return { success: true, summary: result.summary };
    }

    lastError =
      (result &&
        typeof result === "object" &&
        (result.error || "Summary command returned no output")) ||
      "Summary command returned no output";

    if (attempt < maxAttempts) {
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }

  return { success: false, error: lastError };
}

/**
 * Send a generated summary to Discord
 */
export async function sendGeneratedSummary(
  message: Message,
  preferredThread: ThreadChannel | null,
  addResult: AddResult,
  params: {
    sendSummaryOnInsert: boolean;
    logger?: Logger;
    progressPresenter?: ProgressPresenter;
  }
): Promise<void> {
  const { sendSummaryOnInsert, logger, progressPresenter } = params;

  if (!sendSummaryOnInsert) {
    return;
  }

  const marker = getSummaryMarker(addResult.url, addResult.id);
  if (postedSummaryMarkers.has(marker)) {
    logger?.info("Summary already posted for item, skipping duplicate", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
    });
    return;
  }

  const target = await resolveSummaryTarget(message, preferredThread, logger);
  if (!target) {
    logger?.warn("No sendable target available for summary message", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
    });
    return;
  }

  const summaryResult = await generateSummaryWithRetry(
    addResult.url,
    {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    },
    logger
  );

  if (!summaryResult.success) {
    manualReviewSummaryMarkers.add(marker);
    logger?.error("Failed to generate summary after retries; marked for manual review", {
      messageId: message.id,
      targetId: target.id,
      url: addResult.url,
      itemId: addResult.id,
      error: summaryResult.error,
    });

    // Use presenters-level helper to centralise fallback semantics and logging
    await sendWithFallback(target, `⚠️ Failed to generate summary for <${addResult.url}> after ${SUMMARY_RETRY_ATTEMPTS} attempts. Marked for manual review.`, logger);
    return;
  }

  const itemLink = buildOpenBrainItemLink(addResult.id, addResult.url);
  const fullText = formatSummaryMessage({
    summary: summaryResult.summary,
    itemId: addResult.id,
    sourceUrl: addResult.url,
    authorId: message.author.id,
    timestamp: addResult.timestamp,
    itemLink,
  });

  // Decide whether to attach the full summary as a file or send inline.
  const isTooLong = fullText.length > DISCORD_CONTENT_LIMIT;

  // Build a compact snippet to use in messages when the full text is too long.
  const snippet = isTooLong
    ? extractSummaryFromMarkdown(fullText, Math.max(200, DISCORD_CONTENT_LIMIT - 300))
    : fullText;

  const metadata = [
    `OpenBrain item: <${itemLink}>`,
    `Source URL: <${addResult.url}>`,
    `Item ID: ${addResult.id !== undefined ? addResult.id : "unknown"}`,
    `Author: <@${message.author.id}>`,
    `Timestamp: ${addResult.timestamp || new Date().toISOString()}`,
  ].join("\n");

  const snippetMessage = ["🧾 OpenBrain summary", "", snippet, "", metadata].join("\n");

  let anyPosted = false;

  // Prepare attachment for long summaries so it can be used for both reply
  // and thread targets. We build the file buffer regardless but only attach
  // it when needed.
  const filename = `openbrain-summary-${addResult.id ?? "unknown"}.md`;
  const file = { attachment: Buffer.from(fullText, "utf8"), name: filename };

  // Attempt to post a reply to the original message (always attempt)
  try {
    // If not too long, send full text in reply; otherwise send snippet and attach file.
    if (!isTooLong) {
      // Use presenters-layer fallback to prefer send(), reply(), edit(), channel.send()
      await sendWithFallback(message, fullText as any, logger);
    } else {
      await message.reply({ content: snippetMessage, files: [file] } as any);
    }
    anyPosted = true;
  } catch (err) {
    logger?.warn("Failed to send summary as a reply", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Attempt to post to the resolved target (thread preferred or fallback).
    // Post the summary/snippet using the presenters helper which will attempt
    // send -> edit -> channel.send according to available runtime capabilities.
    try {
      if (!isTooLong) {
        await sendWithFallback(target, fullText, logger);
      } else {
        await sendWithFallback(target, snippetMessage, logger);
        // Try best-effort attach when target supports send with files
        try {
          if ((target as any)?.send && typeof (target as any).send === "function") {
            await (target as any).send({ files: [file] });
          }
        } catch {
          // ignore attach failures
        }
      }
      anyPosted = true;
    } catch (err) {
      logger?.error("Failed to post generated summary to target", {
        messageId: message.id,
        targetId: target.id,
        url: addResult.url,
        itemId: addResult.id,
        marker,
        error: err instanceof Error ? err.message : String(err),
      });
    }

  if (anyPosted) {
    postedSummaryMarkers.add(marker);
    manualReviewSummaryMarkers.delete(marker);
    logger?.info("Posted generated summary to Discord (reply and/or target)", {
      messageId: message.id,
      targetId: target.id,
      url: addResult.url,
      itemId: addResult.id,
      marker,
    });
  } else {
    logger?.warn("Did not post generated summary to any destination", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
      marker,
    });
  }
}

/**
 * Clear all summary markers (useful for testing)
 */
export function clearSummaryMarkers(): void {
  postedSummaryMarkers.clear();
  manualReviewSummaryMarkers.clear();
}

/**
 * Get summary marker counts (useful for testing/debugging)
 */
export function getSummaryMarkerCounts(): {
  posted: number;
  manualReview: number;
} {
  return {
    posted: postedSummaryMarkers.size,
    manualReview: manualReviewSummaryMarkers.size,
  };
}
