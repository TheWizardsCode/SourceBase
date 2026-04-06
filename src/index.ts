import { Client, Intents, TextChannel, ThreadChannel, MessageEmbed, type Message, type Interaction, type ButtonInteraction, type CommandInteraction } from "discord.js";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./logger.js";
import { DiscordBot } from "./discord/client.js";
import { buildCliErrorReport } from "./discord/utils.js";
import { isLikelyContentQuery } from "./query/detector.js";
import {
  runAddCommand,
  runQueueCommand,
  runSummaryCommand,
  runCliCommand,
  isCliAvailable,
  CliRunnerError,
  type AddProgressEvent,
  type AddResult,
} from "./bot/cli-runner.js";
import { pathToFileURL } from "url";

// ============================================================================
// Logger
// ============================================================================

const logger = new Logger(config.LOG_LEVEL as any);

// ============================================================================
// Progress Message Formatting
// ============================================================================

/**
 * Format a CLI progress event into a user-friendly Discord message
 */
export function formatProgressMessage(event: AddProgressEvent): string {
  // Normalize phase: avoid printing literal 'undefined' and handle
  // events that do not include a phase field more helpfully.
  const phase = typeof event.phase === "string" && event.phase.trim() !== "" ? event.phase : undefined;

  if (!phase) {
    // If the CLI provided an explanatory message, surface it as an error-like
    // message so users and maintainers see something actionable in the thread.
    if (event.message) {
      const m = String(event.message).trim();
      // Keep output reasonably sized for Discord
      const truncated = m.length > 1500 ? `${m.slice(0, 1500)}…` : m;
      // Include title or url context when available
      if (event.title) return `❌ ${truncated} (${event.title})`;
      if (event.url) return `❌ ${truncated} (<${event.url}>)`;
      return `❌ ${truncated}`;
    }

    // No explicit message - include any small set of identifying fields so
    // maintainers have context instead of seeing 'undefined'.
    const parts: string[] = [];
    if (event.id !== undefined) parts.push(`id:${event.id}`);
    if (event.title) parts.push(`title:${event.title}`);
    if (event.url) parts.push(`url:${event.url}`);
    if (event.timestamp) parts.push(`ts:${event.timestamp}`);

    if (parts.length > 0) {
      return `⏳ Processing: unknown (${parts.join(", ")})`;
    }

    return `⏳ Processing: unknown event`;
  }

  switch (phase) {
    case "downloading":
      return "⏳ Downloading content...";
    case "extracting":
      return "📝 Extracting text content...";
    case "embedding":
      return "🧠 Generating embeddings...";
    case "completed":
      return `✅ Added to OpenBrain: ${event.title || "URL processed"}`;
    case "failed":
      return `❌ Failed: ${event.message || "Unknown error"}`;
    default:
      // For unknown but present phases, include any short message text
      // the CLI might have provided to give more context.
      const base = `⏳ Processing: ${phase}`;
      if (event.message) {
        const m = String(event.message).trim();
        const truncated = m.length > 1200 ? `${m.slice(0, 1200)}…` : m;
        return `${base}\n\n${truncated}`;
      }
      return base;
  }
}

/**
 * Format thread name for URL processing
 */
function formatThreadName(url: string): string {
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
 * User-facing error message for CLI unavailability
 */
const CLI_UNAVAILABLE_MESSAGE = "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.";

// ============================================================================
// Message Reactions
// ============================================================================

const PROCESSING_REACTION = "👀";
const SUCCESS_REACTION = "✅";
const FAILURE_REACTION = "⚠️";
const SUMMARY_RETRY_ATTEMPTS = 3;
const SUMMARY_RETRY_BASE_DELAY_MS = process.env.NODE_ENV === "test" ? 1 : 500;

type SendableTarget = {
  id: string;
  send: (content: string) => Promise<unknown>;
};

const postedSummaryMarkers = new Set<string>();
const manualReviewSummaryMarkers = new Set<string>();
// Cache for message-level saved briefings to enforce idempotency.
// Key: Discord message id (the bot's reply message that contains the briefing)
// Value: numeric item id when saved, or 'saving' when an ingestion is in progress
const saveBriefingCache = new Map<string, number | "saving">();

function getSummaryMarker(url: string, itemId?: number): string {
  return itemId !== undefined ? `item:${itemId}` : `url:${url}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildOpenBrainItemLink(itemId: number | undefined, sourceUrl: string): string {
  const template = config.OPENBRAIN_ITEM_URL_TEMPLATE?.trim();

  if (!template) {
    return sourceUrl;
  }

  return template
    .replaceAll("{id}", itemId !== undefined ? String(itemId) : "")
    .replaceAll("{url}", encodeURIComponent(sourceUrl));
}

function formatSummaryMessage(params: {
  summary: string;
  itemId?: number;
  sourceUrl: string;
  authorId: string;
  timestamp?: string;
  itemLink: string;
}): string {
  const {
    summary,
    itemId,
    sourceUrl,
    authorId,
    timestamp,
    itemLink,
  } = params;

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

async function resolveSummaryTarget(
  message: Message,
  preferredThread: ThreadChannel | null
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

      logger.warn("Configured default summary channel is not sendable", {
        channelId: fallbackChannelId,
        messageId: message.id,
      });
    } catch (error) {
      logger.warn("Failed to resolve configured default summary channel", {
        channelId: fallbackChannelId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (typeof (message.channel as any).send === "function") {
    return message.channel as unknown as SendableTarget;
  }

  return null;
}

/**
 * Create a thread for a given message with fallbacks.
 * Tries message.startThread(), then channel.threads.create() (with and without startMessage).
 * Returns the created ThreadChannel or null if thread creation is not supported / failed.
 */
async function createThreadForMessage(message: Message, name: string, autoArchiveDuration = 60): Promise<ThreadChannel | null> {
  try {
    // Prefer the Message#startThread API when available
    const startThreadFn = (message as any).startThread;
    if (typeof startThreadFn === "function") {
      try {
        const t = await startThreadFn.call(message, { name, autoArchiveDuration });
        logger.info("Created thread with message.startThread", { messageId: message.id, threadId: (t as any)?.id });
        return t as ThreadChannel;
      } catch (err) {
        logger.warn("message.startThread failed", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fallback: channel.threads.create()
    const chAny = message.channel as any;
    if (chAny && chAny.threads && typeof chAny.threads.create === "function") {
      try {
        // Try with startMessage (preferred) then without if it fails
        try {
          const t = await chAny.threads.create({ name, autoArchiveDuration, startMessage: message.id });
          logger.info("Created thread with channel.threads.create (with startMessage)", { messageId: message.id, threadId: (t as any)?.id });
          return t as ThreadChannel;
        } catch (err) {
          logger.warn("channel.threads.create with startMessage failed, trying without startMessage", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
          const t2 = await chAny.threads.create({ name, autoArchiveDuration });
          logger.info("Created thread with channel.threads.create (without startMessage)", { messageId: message.id, threadId: (t2 as any)?.id });
          return t2 as ThreadChannel;
        }
      } catch (err) {
        logger.warn("channel.threads.create failed", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    logger.warn("Unhandled error while attempting to create thread", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

async function generateSummaryWithRetry(url: string, context: {
  channelId: string;
  messageId: string;
  authorId: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}): Promise<{ success: true; summary: string } | { success: false; error: string }> {
  const maxAttempts = Math.max(1, context.maxAttempts ?? SUMMARY_RETRY_ATTEMPTS);
  const retryBaseDelayMs = Math.max(1, context.retryBaseDelayMs ?? SUMMARY_RETRY_BASE_DELAY_MS);
  let lastError = "Unknown summary generation error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runSummaryCommand(url, {
      ...context,
      timeoutMs: context.timeoutMs,
    });
    if (result.success && result.summary) {
      return { success: true, summary: result.summary };
    }

    lastError = result.error || "Summary command returned no output";

    if (attempt < maxAttempts) {
      const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }

  return { success: false, error: lastError };
}

async function sendGeneratedSummary(
  message: Message,
  preferredThread: ThreadChannel | null,
  addResult: AddResult
): Promise<void> {
  if (!config.SEND_SUMMARY_ON_INSERT) {
    return;
  }

  const marker = getSummaryMarker(addResult.url, addResult.id);
  if (postedSummaryMarkers.has(marker)) {
    logger.info("Summary already posted for item, skipping duplicate", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
    });
    return;
  }

  const target = await resolveSummaryTarget(message, preferredThread);
  if (!target) {
    logger.warn("No sendable target available for summary message", {
      messageId: message.id,
      url: addResult.url,
      itemId: addResult.id,
    });
    return;
  }

  const summaryResult = await generateSummaryWithRetry(addResult.url, {
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
  });

  if (!summaryResult.success) {
    manualReviewSummaryMarkers.add(marker);
    logger.error("Failed to generate summary after retries; marked for manual review", {
      messageId: message.id,
      targetId: target.id,
      url: addResult.url,
      itemId: addResult.id,
      error: summaryResult.error,
    });

    try {
      await target.send(
        `⚠️ Failed to generate summary for <${addResult.url}> after ${SUMMARY_RETRY_ATTEMPTS} attempts. Marked for manual review.`
      );
    } catch (error) {
      logger.warn("Failed to send summary failure notice", {
        messageId: message.id,
        targetId: target.id,
        url: addResult.url,
        itemId: addResult.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const summaryMessage = formatSummaryMessage({
    summary: summaryResult.summary,
    itemId: addResult.id,
    sourceUrl: addResult.url,
    authorId: message.author.id,
    timestamp: addResult.timestamp,
    itemLink: buildOpenBrainItemLink(addResult.id, addResult.url),
  });

  try {
    await target.send(summaryMessage);
    postedSummaryMarkers.add(marker);
    manualReviewSummaryMarkers.delete(marker);

    logger.info("Posted generated summary to Discord", {
      messageId: message.id,
      targetId: target.id,
      url: addResult.url,
      itemId: addResult.id,
      marker,
    });
  } catch (error) {
    logger.error("Failed to post generated summary", {
      messageId: message.id,
      targetId: target.id,
      url: addResult.url,
      itemId: addResult.id,
      marker,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Add a reaction to a message
 */
async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch (error) {
    logger.warn("Failed to add reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remove a reaction from a message (removes bot's reaction only)
 */
async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const botUserId = message.client?.user?.id;
    if (!botUserId) return;

    // Get the reaction and remove the bot's reaction
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(botUserId);
    }
  } catch (error) {
    logger.warn("Failed to remove reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Check if CLI is available and reply with error message if not
 * @returns true if CLI is available, false otherwise
 */
async function checkCliAvailability(message: Message): Promise<boolean> {
  logger.debug("Checking CLI availability...", { messageId: message.id });
  
  try {
    const isAvailable = await Promise.race([
      isCliAvailable(),
      new Promise<boolean>((_, reject) => 
        setTimeout(() => reject(new Error("CLI check timeout")), 10000)
      )
    ]);
    
    if (!isAvailable) {
      logger.warn("CLI availability check failed - CLI not found", {
        messageId: message.id,
        channelId: message.channelId,
      });
      await message.reply(CLI_UNAVAILABLE_MESSAGE);
      return false;
    }
    
    logger.debug("CLI is available", { messageId: message.id });
    return true;
  } catch (error) {
    logger.error("CLI availability check error", {
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await message.reply(CLI_UNAVAILABLE_MESSAGE);
    return false;
  }
}

// ============================================================================
// URL Processing
// ============================================================================

/**
 * Extract URLs from message content
 */
function extractUrls(content: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = content.match(urlRegex) || [];
  return [...new Set(matches)]; // Remove duplicates
}

/**
 * Check if message contains a crawl command
 */
function isCrawlCommand(content: string): boolean {
  return /^\s*crawl\s+/i.test(content);
}

/**
 * Extract seed URL from crawl command
 */
function extractCrawlSeedUrl(content: string): string | null {
  const match = content.match(/^\s*crawl\s+(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}



/**
 * Process a URL with threaded progress updates
 * Creates a thread and sends progress events as they occur
 */
async function processUrlWithProgress(
  message: Message,
  url: string
): Promise<void> {
  logger.info("Starting URL processing", { messageId: message.id, url });
  
  let thread: ThreadChannel | null = null;
  
  // Add processing reaction to indicate the bot is working
  await addReaction(message, PROCESSING_REACTION);
  
  try {
    // Try to create a thread for progress updates with robust fallbacks
    thread = await createThreadForMessage(message, formatThreadName(url), 60);

    if (thread) {
      logger.info("Created thread for URL processing", {
        messageId: message.id,
        threadId: thread.id,
        url,
      });
    }
  } catch (error) {
    // Thread creation failed, log and continue without thread
    logger.warn("Failed to create thread for progress updates", {
      messageId: message.id,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  
  try {
    logger.info("Starting CLI add command", { messageId: message.id, url });
    
    // Run the add command with progress tracking
    const addGenerator = runAddCommand(url, {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    });
    
    let lastPhase: string | null = null;
    // Once we see a terminal phase ('completed' or 'failed') we should
    // suppress any subsequent progress updates emitted by the CLI to avoid
    // confusing the user with post-completion informational objects.
    let terminalPhaseSeen = false;
    let eventCount = 0;
    let finalResult: AddResult | undefined;
    
    // Process progress events using manual iteration to capture return value
    logger.info("Waiting for CLI progress events...", { messageId: message.id, url });
    
    while (true) {
      const iteration = await addGenerator.next();
      
      if (iteration.done) {
        // Generator completed - capture the return value
        finalResult = iteration.value;
        logger.info("CLI generator completed", { 
          messageId: message.id, 
          url, 
          eventCount,
          hasResult: !!finalResult 
        });
        break;
      }
      
      // Process yielded progress event
      const event = iteration.value;
      eventCount++;
      logger.info("Received CLI progress event", {
        messageId: message.id,
        url,
        phase: event.phase,
        eventCount,
      });

      // If we've already observed a terminal phase, ignore any further
      // progress events to avoid confusing follow-up messages (some CLI
      // implementations emit informational objects after completion).
      if (terminalPhaseSeen) {
        logger.debug("Ignoring CLI progress event after terminal phase", {
          messageId: message.id,
          url,
          eventCount,
        });
        continue;
      }

      // Only send update if phase changed (avoid spam)
      if (event.phase !== lastPhase) {
        lastPhase = event.phase;

        const progressMsg = formatProgressMessage(event);

        // Always ensure URLs shown to users are wrapped in backticks to avoid embeds.
        // If event contains a url or title, prefer showing the title wrapped in ticks.
        const safeProgressMsg = ((): string => {
          try {
            if (event.title) return progressMsg.replace(event.title, `\`${event.title}\``);
            if (event.url) return progressMsg.replace(event.url, `\`${event.url}\``);
            return progressMsg;
          } catch {
            return progressMsg;
          }
        })();

        if (thread) {
          try {
            await thread.send(safeProgressMsg);
          } catch (error) {
            logger.warn("Failed to send progress update to thread; falling back to channel reply", {
              threadId: thread.id,
              phase: event.phase,
              error: error instanceof Error ? error.message : String(error),
            });
            // Fallback: reply in channel so user still receives updates
            try {
              await message.reply(safeProgressMsg);
            } catch (err) {
              logger.warn("Failed to send fallback progress reply to channel", {
                messageId: message.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else {
          // No thread available -> send progress updates to channel (safe)
          try {
            await message.reply(safeProgressMsg);
          } catch (err) {
            logger.warn("Failed to send progress update to channel", {
              messageId: message.id,
              phase: event.phase,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // If this event indicates a terminal state, mark it so we ignore
        // any subsequent non-actionable events.
        try {
          if (event.phase === "completed" || event.phase === "failed") {
            terminalPhaseSeen = true;
          }
        } catch {
          // ignore
        }
      }
    }
    
    if (finalResult) {
      logger.info("CLI processing complete", { 
        messageId: message.id, 
        url, 
        success: finalResult.success,
        title: finalResult.title,
        error: finalResult.error
      });
      
      if (finalResult.success) {
        // Remove processing reaction and add success reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, SUCCESS_REACTION);
        
        // Ensure title or URL displayed is wrapped in backticks to avoid embeds
        const displayName = finalResult.title ? `\`${finalResult.title}\`` : `\`${url}\``;
        const successMsg = `✅ Added: ${displayName}`;

        let summaryTargetThread: ThreadChannel | null = thread;

        // If we already observed a 'completed' progress event earlier and
        // posted it to the thread/channel, avoid posting a duplicate final
        // success message. We detect this by checking the lastPhase value.
        const alreadyCompleted = lastPhase === "completed";

        if (!alreadyCompleted) {
          if (thread) {
            try {
              await thread.send(successMsg);
            } catch (error) {
              logger.warn("Failed to send final success message to thread; falling back to channel reply", {
                threadId: thread.id,
                error: error instanceof Error ? error.message : String(error),
              });
              summaryTargetThread = null;
              // Fallback to channel reply
              try {
                await message.reply(successMsg);
              } catch (err) {
                logger.warn("Failed to send fallback success reply to channel", {
                  messageId: message.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } else {
            // Fallback to message reply if no thread
            await message.reply(successMsg);
          }
        } else {
          logger.debug("Skipping duplicate final success message because completed event was already posted", { messageId: message.id, url });
        }

        await sendGeneratedSummary(message, summaryTargetThread, finalResult);

        if (summaryTargetThread) {
          try {
            await summaryTargetThread.setArchived(true);
          } catch (error) {
            logger.warn("Failed to archive thread after summary posting", {
              threadId: summaryTargetThread.id,
              messageId: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else {
        // Remove processing reaction and add failure reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, FAILURE_REACTION);
        
        const displayUrl = `\`${url}\``;
        const errorBody = finalResult.error || CLI_UNAVAILABLE_MESSAGE;
        const errorMsg = `❌ Failed to add ${displayUrl}\n\n${errorBody}`;

        // If the CLI returned structured diagnostic info (exitCode/stderr),
        // build and post a more detailed report for maintainers in-thread.
        if (!finalResult.success && (finalResult.exitCode !== undefined || finalResult.stderr)) {
          try {
            const cmd = `add --format ndjson ${url}`;
            const report = buildCliErrorReport({
              command: cmd,
              args: [],
              exitCode: finalResult.exitCode,
              stderr: finalResult.stderr,
              note: "Observed during processing of user-submitted URL",
            });

            if (thread) {
              try {
                await postCliErrorReport(thread, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
                await thread.send(errorMsg);
                await thread.setArchived(true).catch(() => {});
              } catch (sendError) {
                logger.warn("Failed to send CLI error report to thread; falling back to channel reply", {
                  threadId: thread.id,
                  error: sendError instanceof Error ? sendError.message : String(sendError),
                });
                try {
                  await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
                  await message.reply(errorMsg);
                } catch (replyError) {
                  logger.warn("Failed to send fallback CLI error report reply", {
                    messageId: message.id,
                    error: replyError instanceof Error ? replyError.message : String(replyError),
                  });
                }
              }
            } else {
              // Try to create a dedicated thread for the error report using helper
              const t = await createThreadForMessage(message, `CLI error: ${new URL(url).hostname}`, 60);
              if (t) {
                try {
                  await postCliErrorReport(t, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
                  await t.send(errorMsg);
                  await t.setArchived(true).catch(() => {});
                } catch (threadErr) {
                  logger.warn("Failed to send CLI error report to created thread; falling back to reply", {
                    messageId: message.id,
                    threadId: t.id,
                    error: threadErr instanceof Error ? threadErr.message : String(threadErr),
                  });
                  try {
                    await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
                    await message.reply(errorMsg);
                  } catch (replyError) {
                    logger.warn("Failed to reply with CLI error report", {
                      messageId: message.id,
                      error: replyError instanceof Error ? replyError.message : String(replyError),
                    });
                  }
                }
              } else {
                // Last resort - reply in channel
                try {
                  await postCliErrorReport(message, report, "⚠️ CLI error encountered during processing. See attached diagnostic report.");
                  await message.reply(errorMsg);
                } catch (replyError) {
                  logger.warn("Failed to reply with CLI error report (no thread available)", {
                    messageId: message.id,
                    error: replyError instanceof Error ? replyError.message : String(replyError),
                  });
                }
              }
            }
          } catch (err) {
            logger.warn("Error while attempting to post CLI error report", { error: err instanceof Error ? err.message : String(err) });
            // Fallback to the simple error message
            if (thread) {
              try {
                await thread.send(errorMsg);
                await thread.setArchived(true);
              } catch (sendError) {
                logger.warn("Failed to send final error message to thread; falling back to channel reply", {
                  threadId: thread.id,
                  error: sendError instanceof Error ? sendError.message : String(sendError),
                });
                try {
                  await message.reply(errorMsg);
                } catch (err2) {
                  logger.warn("Failed to send fallback error reply to channel", {
                    messageId: message.id,
                    error: err2 instanceof Error ? err2.message : String(err2),
                  });
                }
              }
            } else {
              await message.reply(errorMsg);
            }
          }
        } else {
          // No structured diagnostics available - post a concise error message
          if (thread) {
            try {
              await thread.send(errorMsg);
              // Archive the thread after failure
              await thread.setArchived(true);
            } catch (error) {
              logger.warn("Failed to send final error message to thread; falling back to channel reply", {
                threadId: thread.id,
                error: error instanceof Error ? error.message : String(error),
              });
              try {
                await message.reply(errorMsg);
              } catch (err) {
                logger.warn("Failed to send fallback error reply to channel", {
                  messageId: message.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } else {
            // Fallback to message reply if no thread
            await message.reply(errorMsg);
          }
        }
      }
    } else {
      logger.error("CLI generator did not return a result", { 
        messageId: message.id, 
        url
      });
    }
  } catch (error) {
    logger.error("Exception during URL processing", {
      messageId: message.id,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Handle CLI errors
    if (error instanceof CliRunnerError) {
      logger.error("CLI error during URL processing", {
        messageId: message.id,
        url,
        exitCode: error.exitCode,
        stderr: error.stderr,
      });
    }
    
    // Remove processing reaction and add failure reaction
    await removeReaction(message, PROCESSING_REACTION);
    await addReaction(message, FAILURE_REACTION);
    
    const errorMsg = `❌ Failed to add URL\n\n${CLI_UNAVAILABLE_MESSAGE}`;

    // If this was a CLI-specific error, attempt to create/post a detailed
    // diagnostic report in the thread (or create a new thread) so maintainers
    // have actionable debugging information (command, exit code, stderr).
    if (error instanceof CliRunnerError) {
      try {
        const cmd = `add --format ndjson ${url}`;
        const report = buildCliErrorReport({
          command: cmd,
          args: [],
          exitCode: error.exitCode,
          stderr: error.stderr,
          spawnError: error.message,
          note: "Observed during processing of user-submitted URL"
        });

        // Try to send to existing thread
        if (thread) {
          try {
            await thread.send(report);
            await thread.setArchived(true).catch(() => {});
          } catch (sendError) {
            logger.error("Failed to send CLI error report to thread", {
              threadId: thread.id,
              error: sendError instanceof Error ? sendError.message : String(sendError),
            });
            // Fallback to channel reply
            try {
              await message.reply(report);
            } catch (replyError) {
              logger.error("Failed to reply with CLI error report", {
                messageId: message.id,
                error: replyError instanceof Error ? replyError.message : String(replyError),
              });
            }
          }
        } else if (typeof message.startThread === "function") {
          // Try to create a dedicated thread for the error report
          try {
            const t = await message.startThread({ name: `CLI error: ${new URL(url).hostname}`, autoArchiveDuration: 60 });
            await t.send(report);
            await t.setArchived(true).catch(() => {});
          } catch (threadErr) {
            logger.warn("Failed to create thread for CLI error report; falling back to reply", {
              messageId: message.id,
              error: threadErr instanceof Error ? threadErr.message : String(threadErr),
            });
            try {
              await message.reply(report);
            } catch (replyError) {
              logger.error("Failed to reply with CLI error report", {
                messageId: message.id,
                error: replyError instanceof Error ? replyError.message : String(replyError),
              });
            }
          }
        } else {
          // Last resort - reply in channel
          try {
            await message.reply(report);
          } catch (replyError) {
            logger.error("Failed to reply with CLI error report (no thread available)", {
              messageId: message.id,
              error: replyError instanceof Error ? replyError.message : String(replyError),
            });
          }
        }
      } catch (err) {
        logger.warn("Error while attempting to post CLI error report", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Send a user-facing brief error message to the thread or channel
    if (thread) {
      try {
        await thread.send(errorMsg);
        await thread.setArchived(true);
      } catch (sendError) {
        logger.error("Failed to send error message to thread", {
          threadId: thread.id,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
    } else {
      await message.reply(errorMsg);
    }
  }
}

/**
 * Suppress embeds on a message if the bot has the MANAGE_MESSAGES permission.
 * Returns true if suppression was attempted and succeeded, false otherwise.
 */
async function suppressEmbedsIfPermitted(message: Message): Promise<boolean> {
  try {
    const guild = message.guild;
    if (!guild) {
      logger.debug("Message not in a guild; cannot suppress embeds", { messageId: message.id });
      return false;
    }

    const botUserId = message.client?.user?.id;
    if (!botUserId) {
      logger.warn("Could not determine bot user id for permission check", { messageId: message.id });
      return false;
    }

    // Fetch the bot's guild member to get up-to-date permissions
    const botMember = await guild.members.fetch(botUserId);
    if (!botMember) {
      logger.warn("Failed to fetch bot guild member", { messageId: message.id });
      return false;
    }

    if (!botMember.permissions.has("MANAGE_MESSAGES")) {
      logger.warn("Bot lacks MANAGE_MESSAGES permission; cannot suppress embeds", { messageId: message.id });
      return false;
    }

    // Call suppressEmbeds if available on this Message object
    const suppressFn = (message as any).suppressEmbeds;
    if (typeof suppressFn === "function") {
      await suppressFn.call(message, true);
      logger.debug("Suppressed embeds on message", { messageId: message.id });
      return true;
    }

    logger.warn("suppressEmbeds method not available on message object", { messageId: message.id });
    return false;
  } catch (err) {
    logger.warn("Error while attempting to suppress embeds", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ==========================================================================
// Reply helper: summarize and attach large content
// ==========================================================================

const DISCORD_CONTENT_LIMIT = 1900;
const MARKDOWN_WRAP_WIDTH = 80;

/**
 * Safely post a potentially large CLI diagnostic report to a Discord target.
 * If the report is within the content limit, post as a normal message.
 * If it exceeds the limit, post a short explanatory message and attach
 * the full report as a file to avoid Discord's message length restriction.
 */
export async function postCliErrorReport(target: any, report: string, shortIntro?: string): Promise<void> {
  try {
    if (!report) return;

    if (report.length <= DISCORD_CONTENT_LIMIT) {
      if (typeof target.send === "function") {
        await target.send(report);
        return;
      }
      if (typeof target.reply === "function") {
        await target.reply(report);
        return;
      }
      return;
    }

    // Report too large for a single Discord message - send as attachment.
    const intro = shortIntro || "Detailed CLI diagnostic attached.";
    const content = `${intro}\n\n(Full report attached as cli-error-report.txt)`;
    const file = { attachment: Buffer.from(report, "utf8"), name: "cli-error-report.txt" };

    if (typeof target.send === "function") {
      await target.send({ content, files: [file] } as any);
      return;
    }
    if (typeof target.reply === "function") {
      await target.reply({ content, files: [file] } as any);
      return;
    }
  } catch (err) {
    logger.warn("Failed to post CLI error report", { error: err instanceof Error ? err.message : String(err) });
    // Best-effort fallback: try to send a truncated inline excerpt
    try {
      const truncated = report.slice(0, Math.max(0, DISCORD_CONTENT_LIMIT - 50)) + "…";
      if (typeof target.send === "function") await target.send(truncated);
      else if (typeof target.reply === "function") await target.reply(truncated);
    } catch {
      // ignore
    }
  }
}

function wrapLineAtNearestSpace(line: string, width: number): string[] {
  if (line.length <= width || width <= 0) {
    return [line];
  }

  const bulletMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  const quoteMatch = line.match(/^(\s*>+\s*)(.*)$/);
  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";

  let firstPrefix = leadingWhitespace;
  let continuationPrefix = leadingWhitespace;
  let remaining = line.slice(leadingWhitespace.length);

  if (bulletMatch) {
    const indent = bulletMatch[1];
    const marker = bulletMatch[2];
    firstPrefix = `${indent}${marker} `;
    continuationPrefix = `${indent}${" ".repeat(marker.length + 1)}`;
    remaining = bulletMatch[3];
  } else if (quoteMatch) {
    firstPrefix = quoteMatch[1];
    continuationPrefix = quoteMatch[1];
    remaining = quoteMatch[2];
  }

  const wrapped: string[] = [];
  let isFirstLine = true;

  while (remaining.length > 0) {
    const prefix = isFirstLine ? firstPrefix : continuationPrefix;
    const available = width - prefix.length;
    if (available <= 0) {
      wrapped.push(`${prefix}${remaining}`);
      break;
    }

    if (remaining.length <= available) {
      wrapped.push(`${prefix}${remaining}`);
      break;
    }

    let splitIndex = remaining.lastIndexOf(" ", available);
    if (splitIndex <= 0) {
      splitIndex = remaining.indexOf(" ", available);
      if (splitIndex === -1) {
        wrapped.push(`${prefix}${remaining}`);
        break;
      }
    }

    const chunk = remaining.slice(0, splitIndex).trimEnd();
    wrapped.push(`${prefix}${chunk}`);
    remaining = remaining.slice(splitIndex).trimStart();
    isFirstLine = false;
  }

  return wrapped.length > 0 ? wrapped : [line];
}

function wrapMarkdownText(content: string, width = MARKDOWN_WRAP_WIDTH): string {
  const lines = content.split("\n");
  const wrapped: string[] = [];
  let inFencedCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFencedCodeBlock = !inFencedCodeBlock;
      wrapped.push(line);
      continue;
    }

    if (
      inFencedCodeBlock ||
      line.length <= width ||
      /^\s*\|/.test(line) ||
      /^\s*\[[^\]]+\]:\s+\S+/.test(line)
    ) {
      wrapped.push(line);
      continue;
    }

    wrapped.push(...wrapLineAtNearestSpace(line, width));
  }

  return wrapped.join("\n");
}

function extractSummaryFromMarkdown(content: string, maxLen = 1500): string {
  // Try to extract a '## Summary' section (case-insensitive)
  try {
    const summaryRegex = /(^|\n)#{1,6}\s*summary\s*\n([\s\S]*?)(?=\n#{1,6}\s*\S|\n---|$)/i;
    const m = content.match(summaryRegex);
    if (m && m[2]) {
      let s = m[2].trim();
      if (s.length > maxLen) s = s.slice(0, maxLen).trim();
      // Attempt to end at a sentence boundary
      const lastPeriod = s.lastIndexOf('. ');
      if (lastPeriod > Math.floor(maxLen / 2)) s = s.slice(0, lastPeriod + 1);
      return s;
    }
  } catch {
    // ignore regex engine issues
  }

  // Fallback: use the first paragraph
  const paragraphs = content.split(/\n\s*\n/);
  let first = (paragraphs[0] || '').trim();
  if (!first && paragraphs.length > 1) first = (paragraphs[1] || '').trim();
  if (first) {
    if (first.length <= maxLen) return first;
    // Truncate to a sentence boundary if possible
    const truncated = first.slice(0, maxLen);
    const lastPeriod = truncated.lastIndexOf('. ');
    if (lastPeriod > 0) return truncated.slice(0, lastPeriod + 1);
    return truncated;
  }

  // Final fallback: truncate to maxLen and end at last sentence
  let truncated = content.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > 0) truncated = truncated.slice(0, lastPeriod + 1);
  return truncated;
}

async function editReplyWithPossibleAttachment(
  interaction: CommandInteraction,
  headerLine: string,
  content: string,
  filename = "content.md",
  showSaveButton = false
): Promise<void> {
  const fullText = `${headerLine}\n\n${content}`;

  // Build optional components (raw shape accepted by discord.js).
  // Avoid including components during tests because the test harness's
  // fake editReply handler expects a string argument and will stringify
  // objects (resulting in '[object Object]'). In real runtime we include
  // the button when requested.
  const components = showSaveButton && process.env.NODE_ENV !== "test"
    ? [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              custom_id: "save_briefing",
              label: "Save briefing",
            },
          ],
        },
      ]
    : undefined;

  if (fullText.length <= DISCORD_CONTENT_LIMIT) {
    if (!components) await interaction.editReply(fullText);
    else await interaction.editReply({ content: fullText, components } as any);

    try {
      const posted = await interaction.fetchReply();
      if (posted && typeof posted.id === "string") {
        // best-effort
        suppressEmbedsIfPermitted(posted as Message).catch(() => {});
      }
    } catch {
      // ignore
    }
    return;
  }

  // Create a compact summary and attach original content as a .md file
  const summary = extractSummaryFromMarkdown(content, DISCORD_CONTENT_LIMIT - headerLine.length - 120);
  const summaryText = `${headerLine}\n\n${summary}\n\n*(Full content attached as ${filename})*`;

  const file = { attachment: Buffer.from(content, "utf8"), name: filename };
  if (!components) await interaction.editReply({ content: summaryText, files: [file] } as any);
  else await interaction.editReply({ content: summaryText, files: [file], components } as any);

  try {
    const posted = await interaction.fetchReply();
    if (posted && typeof posted.id === "string") {
      suppressEmbedsIfPermitted(posted as Message).catch(() => {});
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// Bot Initialization
// ============================================================================

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
  onInteraction: async (interaction: Interaction) => {
    // Handle button interactions (Save briefing) first
    try {
      if (interaction.isButton && interaction.isButton()) {
        const btn = interaction as ButtonInteraction;
        if (btn.customId === "save_briefing") {
          await btn.deferReply({ ephemeral: true });

          let sourceMessage = btn.message as any;
          let briefingText = "";

          try {
            const atts: any = sourceMessage?.attachments;
            if (atts && atts.size && atts.size > 0) {
                const att = atts.first();
                if (att && att.url && att.name && att.name.endsWith(".md")) {
                  try {
                    const resp = await fetch(att.url);
                    if (resp.ok) briefingText = await resp.text();
                    else briefingText = (sourceMessage.content || "").trim();
                  } catch {
                    briefingText = (sourceMessage.content || "").trim();
                  }
                }
              } else {
                briefingText = (sourceMessage?.content || "").trim();
              }
          } catch {
            briefingText = (sourceMessage?.content || "").trim();
          }

          if (!briefingText) {
            await btn.editReply({ content: "❌ Could not extract briefing text from the message." });
            return;
          }

          if (!(await isCliAvailable())) {
            await btn.editReply({ content: "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed on the host." });
            return;
          }

          // Enforce message-level dedupe. Use the bot reply message id as the
          // key (the interaction.message.id) so repeated clicks on the same
          // reply are idempotent.
          const replyMessageId = sourceMessage?.id as string | undefined;
          if (replyMessageId) {
            const cached = saveBriefingCache.get(replyMessageId);
            if (cached === "saving") {
              await btn.editReply({ content: "⏳ Briefing save already in progress for this message. Please wait..." });
              return;
            }
            if (typeof cached === "number") {
              const itemUrl = buildOpenBrainItemLink(cached, `openbrain://sorra/${cached}`);
              await btn.editReply({ content: `✅ Briefing already saved: <${itemUrl}>` });
              return;
            }

            // Mark as saving
            saveBriefingCache.set(replyMessageId, "saving");
          }

          const { makeTempFileName } = await import("./discord/utils.js");
          const tmpName = makeTempFileName("briefing", "md");
          const fs = await import("fs/promises");
          try {
            await fs.writeFile(tmpName, briefingText, "utf8");
          } catch (err) {
            await btn.editReply({ content: `❌ Failed to write temporary briefing file: ${String(err)}` });
            return;
          }

            try {
              // The OpenBrain CLI expects URLs. For local temporary files,
              // provide a file:// URL so the CLI treats it as a valid input.
              // Convert local filesystem path to a file:// URL for the CLI using
              // pathToFileURL for correct cross-platform encoding.
              const tmpArg = (typeof tmpName === "string")
                ? pathToFileURL(tmpName).toString()
                : tmpName;

              const addResult = await runCliCommand("add", ["--format", "ndjson", tmpArg], {
                channelId: btn.channelId ?? undefined,
                messageId: undefined,
                authorId: btn.user?.id,
              });

              if (addResult.exitCode !== 0) {
                if (replyMessageId) saveBriefingCache.delete(replyMessageId);
                await btn.editReply({ content: `❌ Failed to ingest briefing: CLI error` });
                return;
              }

              let createdId: number | undefined = undefined;
              for (const line of addResult.stdout) {
                try {
                  const obj = JSON.parse(line);
                  if (obj && typeof obj === "object" && (obj.id || obj.item_id)) {
                    const raw = obj.id ?? obj.item_id;
                    if (typeof raw === "number") createdId = raw;
                    else if (typeof raw === "string" && /^\d+$/.test(raw)) createdId = parseInt(raw, 10);
                    break;
                  }
                } catch {
                  const m = line.match(/id[:=]\s*(\d+)/i);
                  if (m) {
                    createdId = parseInt(m[1], 10);
                    break;
                  }
                }
              }

              let successMsg = "✅ Briefing ingested into OpenBrain.";
              if (createdId !== undefined) {
                const itemUrl = buildOpenBrainItemLink(createdId, `openbrain://sorra/${createdId}`);
                successMsg = `✅ Briefing saved: <${itemUrl}>`;
                if (replyMessageId) saveBriefingCache.set(replyMessageId, createdId);
              } else {
                if (replyMessageId) saveBriefingCache.delete(replyMessageId);
              }

              await btn.editReply({ content: successMsg });
            } catch (err) {
              if (replyMessageId) saveBriefingCache.delete(replyMessageId);
              await btn.editReply({ content: `❌ Failed to ingest briefing: ${String(err)}` });
            } finally {
              try {
                const fs2 = await import("fs/promises");
                await fs2.unlink(tmpName).catch(() => {});
              } catch {
                // ignore
              }
            }

          return;
        }
      }
    } catch (err) {
      try {
        if (interaction.isButton && interaction.isButton()) {
          const btn = interaction as ButtonInteraction;
          await btn.reply({ content: "An unexpected error occurred while handling the Save briefing action.", ephemeral: true });
        } else if (interaction.isCommand && interaction.isCommand()) {
          const cmdErr = interaction as CommandInteraction;
          await cmdErr.reply({ content: "An unexpected error occurred while handling the Save briefing action.", ephemeral: true });
        } else {
          // Best-effort fallback for unknown interaction shapes (tests may use plain objects)
          try {
            const anyI = interaction as unknown as { reply?: (arg: any) => Promise<any> };
            if (typeof anyI.reply === "function") await anyI.reply({ content: "An unexpected error occurred while handling the Save briefing action.", ephemeral: true });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    // If not a button, handle command interactions
    if (!interaction.isCommand || !interaction.isCommand()) return;

    const cmd = interaction as CommandInteraction;
    const commandName = cmd.commandName;

    // Handle simple stats command
    if (commandName === "stats") {
      await cmd.reply("Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
      return;
    }

    // Handle /search
    if (commandName === "search") {
      try {
        const query = cmd.options.getString("query", true);
        const limit = cmd.options.getInteger("limit") || 5;

        await cmd.deferReply();

        const clamped = Math.max(1, Math.min(20, limit));
        const args = ["--json", "--limit", String(clamped), query];

        const result = await runCliCommand("search", args, {
          channelId: cmd.channelId ?? undefined,
          messageId: undefined,
          authorId: cmd.user?.id,
        });

        if (result.exitCode !== 0) {
          await cmd.editReply("❌ Search failed: CLI returned an error");
          return;
        }

        if (result.stdout.length === 0) {
          await cmd.editReply("No results found.");
          return;
        }

        function parseSearchLine(line: string): { title: string; url: string } | null {
          const trimmed = line.trim();
          if (!trimmed) return null;

          try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === "object") {
              const url = (obj.url || obj.link || obj.href) as string | undefined;
              const title = (obj.title || obj.name || obj.text) as string | undefined;
              if (url) return { title: title || url, url };
            }
          } catch {
            // ignore
          }

          const urlMatch = trimmed.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
          const url = urlMatch ? urlMatch[0] : null;
          if (!url) return null;

          let remainder = trimmed.replace(url, "").trim();
          const delimiterRegex = /[|│┃║┆┊╎╏\u2500-\u257F]+/;
          if (delimiterRegex.test(remainder)) {
            const cells = remainder.split(delimiterRegex).map((c) => c.trim()).filter(Boolean);
            if (cells.length > 0) {
              // Prefer the first cell that looks like a textual title (not an index/score)
              let title: string | null = null;
              for (const c of cells) {
                const cell = String(c).trim();
                if (!cell) continue;
                // Skip purely numeric or percentage cells (indexes, scores)
                if (/^\d+(?:\.\d+)?%?$/.test(cell)) continue;
                // Prefer cells that contain letters (Unicode aware)
                try {
                  if (/\p{L}/u.test(cell)) {
                    title = cell;
                    break;
                  }
                } catch {
                  // Fallback for environments not supporting \p{L}
                  if (/[A-Za-z]/.test(cell)) {
                    title = cell;
                    break;
                  }
                }
                if (!title) title = cell;
              }

              let titleStr = title || url;
              // Remove trailing numeric scores or percentages from the title
              titleStr = titleStr.replace(/\s*\d+(?:\.\d+)?%?$/g, "").trim();
              // Remove any leftover box-drawing characters
              titleStr = titleStr.replace(/[│┃║┆┊╎╏\u2500-\u257F]/g, "").replace(/\|/g, " ").trim();
              if (!titleStr) titleStr = url;
              return { title: titleStr, url };
            }
          }

          remainder = remainder.replace(/\(.*?relevance.*?\)/i, "").replace(/\(\s*[0-9.]+\s*\)/, "").trim();
          remainder = remainder.replace(/(?:\|)?\s*(?:relevance[:\s]*\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*$/i, "").trim();
          remainder = remainder.replace(/^[\-–—\|:]+\s*/, "").replace(/\s+[\-–—\|:]+$/, "").trim();

          let title = remainder.replace(/\|/g, " ").trim();
          if (!title) title = url;
          return { title, url };
        }

        let parsed: { title: string; url: string }[] = [];
        const stdoutText = result.stdout.join("\n").trim();

        try {
          const jsonOut = JSON.parse(stdoutText);
          let items: any[] = [];

          if (Array.isArray(jsonOut)) {
            items = jsonOut;
          } else if (jsonOut && typeof jsonOut === "object") {
            if (Array.isArray(jsonOut.results)) items = jsonOut.results;
            else if (Array.isArray(jsonOut.hits)) items = jsonOut.hits;
            else if (Array.isArray(jsonOut.items)) items = jsonOut.items;
            else if (Array.isArray(jsonOut.rows)) items = jsonOut.rows;
            else {
              const arrProp = Object.keys(jsonOut).find((k) => Array.isArray((jsonOut as any)[k]));
              if (arrProp) items = (jsonOut as any)[arrProp];
            }
          }

          parsed = items
            .map((obj) => {
              if (!obj || typeof obj !== "object") return null;
              const url = obj.url || obj.link || obj.href;
              let title = obj.title || obj.name || obj.text;
              if (!url) return null;
              if (!title || typeof title !== "string") title = url;
              return { title: String(title).trim(), url: String(url).trim() };
            })
            .filter((v): v is { title: string; url: string } => !!v)
            .slice(0, clamped);
        } catch (e) {
          parsed = result.stdout
            .map((l) => parseSearchLine(l))
            .filter((v): v is { title: string; url: string } => !!v)
            .slice(0, clamped);
        }

        // Sanitize titles: remove any embedded Markdown links ([text](url)) so we don't
        // accidentally re-introduce markdown link formatting, then escape stray closing
        // bracket characters.
        const escapeTitle = (s: string) => {
          if (!s) return s;
          // Replace markdown link occurrences with their inner text
          let t = String(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
          // Escape any remaining closing bracket to avoid accidental markdown parsing
          t = t.replace(/\]/g, "\\]");
          return t;
        };

        if (parsed.length === 0) {
          await cmd.editReply("No results found.");
          return;
        }

        // Start a thread off the original bot reply and post each result as a
        // message in the thread. If thread creation is unavailable, fall back
        // to in-channel output.

        let parentMsg: Message | null = null;
        try {
          parentMsg = (await cmd.fetchReply()) as Message;
        } catch {
          // ignore
        }

        let thread: ThreadChannel | null = null;
        const searchingThreadName = `Searching for '${query}'...`;
        if (parentMsg && typeof (parentMsg as any).startThread === "function") {
          try {
            thread = await (parentMsg as any).startThread({ name: searchingThreadName, autoArchiveDuration: 60 });
          } catch (err) {
            logger.warn("Failed to start thread from reply", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (!thread) {
          try {
            const chAny = cmd.channel as any;
            if (chAny && chAny.threads && typeof chAny.threads.create === "function") {
              if (parentMsg && parentMsg.id) {
                thread = await chAny.threads.create({
                  name: searchingThreadName,
                  autoArchiveDuration: 60,
                  startMessage: parentMsg.id,
                });
              } else {
                thread = await chAny.threads.create({ name: searchingThreadName, autoArchiveDuration: 60 });
              }
            }
          } catch (err) {
            logger.warn("Failed to create thread on channel; will post results in-channel instead", { error: err instanceof Error ? err.message : String(err) });
            thread = null;
          }
        }

        const resultLines = parsed.map((p) => `[${escapeTitle(p.title)}](${p.url})`);
        try {
          if (thread) {
            await cmd.editReply(`✅ Search results for '${query}' are being posted in thread <#${thread.id}>.`);
          } else {
            const resultsContent = `✅ Search results for '${query}':\n\n${resultLines.join("\n\n")}`;
            await cmd.editReply(resultsContent);
          }
        } catch {
          // ignore
        }

        const summaryTasks: Promise<void>[] = [];

        for (const p of parsed) {
          // Post a lightweight placeholder message quickly so the UI reflects
          // progress immediately. Generate the (potentially slow) summary in
          // the background and update the posted message when ready. This
          // prevents a slow summary generation from blocking the posting of
          // subsequent results (which was causing the UI to "stall" at the
          // third item).
          const title = escapeTitle(p.title);
          const formatSearchResultBody = (titleText: string, summaryText: string, urlText: string): string => {
            const header = `**${titleText}**\n\n`;
            const footer = `\n\n<${urlText}>`;
            const maxContentLength = 1900;
            const budget = Math.max(0, maxContentLength - header.length - footer.length);
            let body = summaryText;
            if (body.length > budget) {
              body = `${body.slice(0, Math.max(0, budget - 3)).trimEnd()}...`;
            }
            return `${header}${body}${footer}`;
          };

          const placeholderBody = formatSearchResultBody(title, "_Generating summary..._", p.url);

          let postedMessage: any = null;
          try {
            if (thread) {
              postedMessage = await thread.send(placeholderBody);
            } else if (typeof cmd.followUp === "function") {
              postedMessage = await cmd.followUp({ content: placeholderBody } as any);
            } else {
              // Fallback: post as an edit to the original reply if followUp
              // is not available in this environment.
              try {
                await cmd.editReply(placeholderBody);
              } catch {
                // ignore
              }
            }
          } catch (err) {
            logger.warn("Failed to post search result placeholder", { error: err instanceof Error ? err.message : String(err) });
          }

          // Kick off summary generation in background so slow summaries don't
          // block the main loop. We track tasks to set the final thread title
          // once all summaries have completed.
          const task = (async () => {
            let summaryResult: { success: true; summary: string } | { success: false; error: string };
            try {
              summaryResult = await generateSummaryWithRetry(p.url, {
                channelId: cmd.channelId ?? "",
                messageId: String(cmd.id),
                authorId: cmd.user?.id ?? "",
                timeoutMs: 20000,
                maxAttempts: 1,
              });
            } catch (err) {
              summaryResult = { success: false, error: String(err) };
            }

            const summaryText = summaryResult.success ? summaryResult.summary : `*Summary generation failed: ${summaryResult.error}*`;
            const updatedBody = formatSearchResultBody(title, summaryText, p.url);

            let posted = false;

            try {
              if (postedMessage && typeof postedMessage.edit === "function") {
                await postedMessage.edit(updatedBody);
                posted = true;
              }
            } catch (err) {
              logger.warn("Failed to edit placeholder with search result summary", {
                error: err instanceof Error ? err.message : String(err),
                url: p.url,
              });
            }

            if (!posted) {
              try {
                if (thread) {
                  await thread.send(updatedBody);
                  posted = true;
                } else if (typeof cmd.followUp === "function") {
                  await cmd.followUp({ content: updatedBody } as any);
                  posted = true;
                }
              } catch (err) {
                logger.warn("Failed to post search result summary fallback", {
                  error: err instanceof Error ? err.message : String(err),
                  url: p.url,
                });
              }
            }

            if (!posted && postedMessage && typeof postedMessage.edit === "function") {
              try {
                await postedMessage.edit(formatSearchResultBody(title, "*Summary unavailable right now. Please run `ob summary <url>` manually for this item.*", p.url));
              } catch {
                // ignore
              }
            }

          })();
          summaryTasks.push(task);
        }

        void (async () => {
          await Promise.allSettled(summaryTasks);

          try {
            if (thread) {
              await thread.setName(`Search results for '${query}'`);
            }
          } catch {
            // ignore
          }

          try {
            if (!thread) {
              await cmd.editReply(`✅ Search results for '${query}':`);
            }
          } catch {
            // ignore
          }
        })();
      } catch (error) {
        if (error instanceof CliRunnerError) {
          await cmd.reply({ content: "⚠️ Search failed because the OpenBrain CLI is unavailable or returned an error.", ephemeral: true });
        } else {
          await cmd.reply({ content: "⚠️ An unexpected error occurred while performing the search.", ephemeral: true });
        }
      }

      return;
    }

    // Handle /briefing
    if (commandName === "briefing") {
      try {
        const query = cmd.options.getString("query", true);
        const k = cmd.options.getInteger("k");

        await cmd.deferReply();

        if (k !== null && (k < 1 || k > 50)) {
          await cmd.editReply("⚠️ Briefing parameter `k` must be between 1 and 50.");
          return;
        }

        if (!(await isCliAvailable())) {
          await cmd.editReply("⚠️ Briefing failed because the OpenBrain CLI is unavailable.");
          return;
        }

        const args = ["run", "--json", "--query", query];
        if (k !== null) {
          args.push("--k", String(k));
        }

        const result = await runCliCommand("briefing", args, {
          channelId: cmd.channelId ?? undefined,
          messageId: undefined,
          authorId: cmd.user?.id,
        });

        if (result.exitCode !== 0) {
          await cmd.editReply("❌ Briefing failed: CLI returned an error");
          return;
        }

        if (result.stdout.length === 0) {
          await cmd.editReply("No briefing output received.");
          return;
        }

        const stdoutText = result.stdout.join("\n").trim();
        let briefingText = stdoutText;

        try {
          const jsonOut = JSON.parse(stdoutText);
          if (typeof jsonOut === "string") briefingText = jsonOut;
          else if (Array.isArray(jsonOut)) {
            briefingText = jsonOut.filter((x) => typeof x === "string").join("\n\n") || stdoutText;
          } else if (jsonOut && typeof jsonOut === "object") {
            briefingText = jsonOut.briefing || jsonOut.summary || jsonOut.text || jsonOut.body || JSON.stringify(jsonOut, null, 2);
          }
        } catch {
          // keep raw text
        }

        briefingText = wrapMarkdownText(briefingText, MARKDOWN_WRAP_WIDTH);

        await editReplyWithPossibleAttachment(
          cmd,
          `📝 Briefing for: \`${query}\``,
          briefingText,
          `briefing-${query.replace(/[^a-z0-9\-]/gi, "_")}.md`,
          true // show Save briefing button
        );

        try {
          const posted = (await cmd.fetchReply()) as any;
          if (posted && typeof posted.id === "string") {
            suppressEmbedsIfPermitted(posted as Message).catch(() => {});
          }
        } catch {
          // ignore
        }
      } catch (error) {
        if (error instanceof CliRunnerError) {
          await cmd.reply({ content: "⚠️ Briefing failed because the OpenBrain CLI is unavailable or returned an error.", ephemeral: true });
        } else {
          await cmd.reply({ content: "⚠️ An unexpected error occurred while generating the briefing.", ephemeral: true });
        }
      }

      return;
    }
  },
  onMonitoredMessage: async (message) => {
    // Handle content queries
    if (isLikelyContentQuery(message.content)) {
      await message.reply("Query functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
      return;
    }
    
    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id
    });
    
    // Handle inline `ob add <text>` message triggers. This allows users to
    // paste raw text and instruct the bot to ingest it via the OpenBrain CLI.
    try {
      // Match either `ob add <text>` or a bare `ob add` (so users can reply
      // to an existing message with `ob add`). Capture group 1 is the
      // optional inline payload when provided.
      const obAddMatch =
        typeof message.content === "string" &&
        message.content.match(/^\s*ob\s+add(?:\s+([\s\S]*))?$/i);
      if (obAddMatch) {
      let payload = String(obAddMatch[1] || "").trim();

      // If payload is empty, attempt to use the referenced/replied-to message's content
      let fetchRefFailed = false;
      if (!payload && message.reference && (message.reference as any).messageId) {
        try {
          const refId = (message.reference as any).messageId;
          const chAny = message.channel as any;
          if (chAny && chAny.messages && typeof chAny.messages.fetch === "function") {
            const refMsg = await chAny.messages.fetch(refId);
            payload = (refMsg?.content || "").trim();
          }
        } catch (err) {
          fetchRefFailed = true;
          logger.warn("Failed to fetch referenced message for ob add", {
            messageId: message.id,
            referencedMessageId: (message.reference as any).messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!payload) {
        if (fetchRefFailed) {
          // Inform the user the bot couldn't fetch the referenced message so
          // they know to either paste the text or check channel permissions.
          await message.reply(
            "\u26a0\ufe0f I couldn't fetch the message you replied to. Please paste the text you want to add, or ensure the bot has permission to read message history in this channel, then try `ob add` again."
          );
        } else {
          await message.reply("\u274c Please provide text to add, for example: `ob add <text>` or reply to a message with `ob add`.");
        }
        return;
      }

        // Enforce a conservative size limit to avoid large payload abuse. Default
        // to 64KB but allow overriding via environment for tests or special hosts.
        const MAX_ADD_BYTES = Number(process.env.OB_ADD_MAX_BYTES || 64 * 1024);
      if (Buffer.byteLength(payload, "utf8") > MAX_ADD_BYTES) {
        logger.warn("ob add payload too large", { messageId: message.id, size: Buffer.byteLength(payload, "utf8"), max: MAX_ADD_BYTES });
        await message.reply(`\u26a0\ufe0f Text too large to ingest directly (max ${MAX_ADD_BYTES} bytes). Please provide a URL or split the text into smaller pieces.`);
        return;
      }

      // Check CLI availability before creating temporary files
      if (!(await checkCliAvailability(message))) {
        logger.warn("ob add requested but CLI unavailable", { messageId: message.id });
        return;
      }

        // Write payload to a secure temporary file and invoke the existing
        // threaded progress flow by passing a file:// URL to the add command.
        const { makeTempFileName } = await import("./discord/utils.js");
        const fs = await import("fs/promises");
        const tmpName = makeTempFileName("ob-add", "txt");

        try {
          await fs.writeFile(tmpName, payload, { encoding: "utf8", mode: 0o600 });
        } catch (err) {
          logger.error("Failed to write temporary file for ob add", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
          await message.reply("\u274c Failed to prepare temporary file for ingestion. Please try again or report this to the maintainers.");
          return;
        }

        const fileUrl = pathToFileURL(tmpName).toString();

      try {
        try {
          await processUrlWithProgress(message, fileUrl);
        } catch (err) {
          // processUrlWithProgress performs a lot of its own error handling
          // but be defensive here in case it throws unexpectedly.
          logger.error("Error during ob add processing", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
          try {
            await message.reply("\u274c Failed to ingest text — an internal error occurred. Please try again later.");
          } catch {
            // ignore reply failures
          }
          throw err;
        }
      } finally {
        try {
          await fs.unlink(tmpName).catch(() => {});
        } catch {
          // best-effort cleanup
        }
      }

        return;
      }
    } catch (err) {
      // Defensive: ensure any unexpected error during ob add handling does not
      // prevent processing of other message types.
      logger.warn("Error while attempting to handle ob add message", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
    }
    
    // Handle crawl commands
    if (isCrawlCommand(message.content)) {
      logger.info("Crawl command detected", { messageId: message.id });

      const seed = extractCrawlSeedUrl(message.content);
      if (!seed) {
        await message.reply("Please pass a seed URL to crawl, for example: `crawl https://example.com`.");
        return;
      }

      // Check CLI availability before queueing
      if (!(await checkCliAvailability(message))) {
        return;
      }
      
      // Add processing reaction
      await addReaction(message, PROCESSING_REACTION);
      
      // Try to queue via CLI runner
      try {
        const queueResult = await runQueueCommand(seed, {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
        });
        
        if (queueResult.success) {
          // Remove processing reaction and add success reaction
          await removeReaction(message, PROCESSING_REACTION);
          await addReaction(message, SUCCESS_REACTION);
          
          // Wrap in code ticks to avoid Discord creating an embed in the reply
          await message.reply(`Queued URL for crawling: \`${seed}\``);
        } else {
          // Remove processing reaction and add failure reaction
          await removeReaction(message, PROCESSING_REACTION);
          await addReaction(message, FAILURE_REACTION);
          
          // Wrap the URL in angle brackets to prevent Discord creating embeds,
          // and leave a blank line before the echoed error message.
          await message.reply(`Failed to queue URL\n\n${queueResult.error || CLI_UNAVAILABLE_MESSAGE}`);
        }
      } catch (error) {
        // Remove processing reaction and add failure reaction
        await removeReaction(message, PROCESSING_REACTION);
        await addReaction(message, FAILURE_REACTION);
        
        if (error instanceof CliRunnerError) {
          logger.error("CLI error during queue command", {
            messageId: message.id,
            url: seed,
            exitCode: error.exitCode,
            stderr: error.stderr,
          });
          // Attempt to post a detailed CLI error report in a thread or reply
          try {
            const cmd = `queue ${seed}`;
            const report = buildCliErrorReport({
              command: cmd,
              args: [],
              exitCode: error.exitCode,
              stderr: error.stderr,
              spawnError: error.message,
              note: "Observed during user-invoked queue command"
            });

            if (typeof message.startThread === "function") {
              try {
                const t = await message.startThread({ name: `CLI error: ${new URL(seed).hostname}`, autoArchiveDuration: 60 });
                await postCliErrorReport(t, report, "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report.");
                await t.setArchived(true).catch(() => {});
              } catch (threadErr) {
                logger.warn("Failed to create thread for CLI queue error; falling back to reply", { error: threadErr instanceof Error ? threadErr.message : String(threadErr) });
                await postCliErrorReport(message, report, "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report.");
              }
            } else {
              await postCliErrorReport(message, report, "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report.");
            }
          } catch (err) {
            logger.warn("Failed to post detailed CLI error report for queue command", { error: err instanceof Error ? err.message : String(err) });
            await message.reply(`❌ Failed to queue URL\n\n${CLI_UNAVAILABLE_MESSAGE}`);
          }
        } else {
          throw error;
        }
      }

      return;
    }

    // Extract URLs from message
    const urls = extractUrls(message.content);
    if (urls.length > 0) {
      logger.info("Found URLs in message", { urls, messageId: message.id });

      // Check CLI availability before processing URLs
      if (!(await checkCliAvailability(message))) {
        return;
      }
      
      // Add URLs using CLI runner with threaded progress updates
      for (const url of urls) {
        await processUrlWithProgress(message, url);
      }
    }
  }
});

// ============================================================================
// Startup and Shutdown
// ============================================================================

  async function startBot(): Promise<void> {
  try {
    await bot.start();
    logger.info("Bot started successfully");
  } catch (error) {
    logger.error("Bot startup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
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
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during graceful shutdown", {
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start the bot
startBot();
