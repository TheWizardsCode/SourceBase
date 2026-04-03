import { Client, Intents, TextChannel, ThreadChannel, MessageEmbed, type Message } from "discord.js";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./logger.js";
import { DiscordBot } from "./discord/client.js";
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
function formatProgressMessage(event: AddProgressEvent): string {
  switch (event.phase) {
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
      return `⏳ Processing: ${event.phase}`;
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

async function generateSummaryWithRetry(url: string, context: {
  channelId: string;
  messageId: string;
  authorId: string;
}): Promise<{ success: true; summary: string } | { success: false; error: string }> {
  let lastError = "Unknown summary generation error";

  for (let attempt = 1; attempt <= SUMMARY_RETRY_ATTEMPTS; attempt++) {
    const result = await runSummaryCommand(url, context);
    if (result.success && result.summary) {
      return { success: true, summary: result.summary };
    }

    lastError = result.error || "Summary command returned no output";

    if (attempt < SUMMARY_RETRY_ATTEMPTS) {
      const delayMs = SUMMARY_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
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
    // Try to create a thread for progress updates
    thread = await message.startThread({
      name: formatThreadName(url),
      autoArchiveDuration: 60, // Archive after 1 hour of inactivity
    });
    
    logger.info("Created thread for URL processing", {
      messageId: message.id,
      threadId: thread.id,
      url,
    });
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
        eventCount 
      });
      
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
  interaction: any,
  headerLine: string,
  content: string,
  filename = "content.md"
): Promise<void> {
  const fullText = `${headerLine}\n\n${content}`;

  if (fullText.length <= DISCORD_CONTENT_LIMIT) {
    await interaction.editReply(fullText);
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
  await interaction.editReply({ content: summaryText, files: [file] } as any);

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
  onInteraction: async (interaction) => {
    if (!interaction.isCommand()) return;

    const commandName = interaction.commandName;

    // Handle simple stats command
    if (commandName === "stats") {
      await interaction.reply("Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
      return;
    }

    // Handle /search
    if (commandName === "search") {
      try {
        const query = interaction.options.getString("query", true);
        const limit = interaction.options.getInteger("limit") || 5;

        await interaction.deferReply();

        const clamped = Math.max(1, Math.min(20, limit));
        const args = ["--json", "--limit", String(clamped), query];

        const result = await runCliCommand("search", args, {
          channelId: interaction.channelId ?? undefined,
          messageId: undefined,
          authorId: interaction.user?.id,
        });

        if (result.exitCode !== 0) {
          await interaction.editReply("❌ Search failed: CLI returned an error");
          return;
        }

        if (result.stdout.length === 0) {
          await interaction.editReply("No results found.");
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
          await interaction.editReply("No results found.");
          return;
        }

        // Start a thread off the original bot reply and post each result as a message
        // in the thread. Update the thread title to reflect progress and final state.
        try {
          // Post formatted results into the original reply so tests and users
          // who do not support threads still see the results. Keep the
          // existing thread/posting behaviour below for environments that
          // support threads; this editReply acts as the primary visible
          // result container.
          const resultLines = parsed.map((p) => `[${escapeTitle(p.title)}](${p.url})`);
          const resultsContent = `✅ Search results for '${query}':\n\n${resultLines.join("\n\n")}`;
          await interaction.editReply(resultsContent);
        } catch {
          // ignore
        }

        let parentMsg: Message | null = null;
        try {
          parentMsg = (await interaction.fetchReply()) as Message;
        } catch {
          // ignore
        }

        let thread: ThreadChannel | null = null;
        if (parentMsg && typeof (parentMsg as any).startThread === "function") {
          try {
            thread = await (parentMsg as any).startThread({ name: `Searching: '${query}'`, autoArchiveDuration: 60 });
          } catch (err) {
            logger.warn("Failed to start thread from reply", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (!thread) {
          try {
            const chAny = interaction.channel as any;
            if (chAny && chAny.threads && typeof chAny.threads.create === "function") {
              thread = await chAny.threads.create({ name: `Searching: '${query}'`, autoArchiveDuration: 60 });
            }
          } catch (err) {
            logger.warn("Failed to create thread on channel; will post results in-channel instead", { error: err instanceof Error ? err.message : String(err) });
            thread = null;
          }
        }

        let postedCount = 0;
        for (const p of parsed) {
          // Post a lightweight placeholder message quickly so the UI reflects
          // progress immediately. Generate the (potentially slow) summary in
          // the background and update the posted message when ready. This
          // prevents a slow summary generation from blocking the posting of
          // subsequent results (which was causing the UI to "stall" at the
          // third item).
          const title = escapeTitle(p.title);
          const placeholderBody = `**${title}**\n\n_Generating summary..._\n\n<${p.url}>`;

          let postedMessage: any = null;
          try {
            if (thread) {
              postedMessage = await thread.send(placeholderBody);
            } else if (typeof interaction.followUp === "function") {
              postedMessage = await interaction.followUp({ content: placeholderBody } as any);
            } else {
              // Fallback: post as an edit to the original reply if followUp
              // is not available in this environment.
              try {
                await interaction.editReply(placeholderBody);
              } catch {
                // ignore
              }
            }
          } catch (err) {
            logger.warn("Failed to post search result placeholder", { error: err instanceof Error ? err.message : String(err) });
          }

          postedCount++;
          try {
            if (thread) await thread.setName(`Searching: '${query}' (${postedCount}/${parsed.length})`);
          } catch {
            // ignore
          }

          // Kick off summary generation in background so slow summaries don't
          // block the main loop. We intentionally do not await this Promise.
          (async () => {
            let summaryResult: { success: true; summary: string } | { success: false; error: string };
            try {
              summaryResult = await generateSummaryWithRetry(p.url, {
                channelId: interaction.channelId ?? "",
                messageId: String(interaction.id),
                authorId: interaction.user?.id ?? "",
              });
            } catch (err) {
              summaryResult = { success: false, error: String(err) };
            }

            const summaryText = summaryResult.success ? summaryResult.summary : `*Summary generation failed: ${summaryResult.error}*`;
            const safeSummary = summaryText.length > 3900 ? summaryText.slice(0, 3900) + "..." : summaryText;

            const updatedBody = `**${title}**\n\n${safeSummary}\n\n<${p.url}>`;

            try {
              if (postedMessage && typeof postedMessage.edit === "function") {
                await postedMessage.edit(updatedBody);
              } else if (thread) {
                await thread.send(updatedBody);
              } else if (typeof interaction.followUp === "function") {
                await interaction.followUp({ content: updatedBody } as any);
              }
            } catch (err) {
              logger.warn("Failed to post search result summary", { error: err instanceof Error ? err.message : String(err) });
            }
          })();
        }

        try {
          if (thread) await thread.setName(`Search results for '${query}':`);
        } catch {
          // ignore
        }

        try {
          await interaction.editReply(`✅ Search results for '${query}':`);
        } catch {
          // ignore
        }
      } catch (error) {
        if (error instanceof CliRunnerError) {
          await interaction.reply({ content: "⚠️ Search failed because the OpenBrain CLI is unavailable or returned an error.", ephemeral: true });
        } else {
          await interaction.reply({ content: "⚠️ An unexpected error occurred while performing the search.", ephemeral: true });
        }
      }

      return;
    }

    // Handle /briefing
    if (commandName === "briefing") {
      try {
        const query = interaction.options.getString("query", true);

        await interaction.deferReply();

        if (!(await isCliAvailable())) {
          await interaction.editReply("⚠️ Briefing failed because the OpenBrain CLI is unavailable.");
          return;
        }

        const args = ["run", "--json", "--query", query];
        const result = await runCliCommand("briefing", args, {
          channelId: interaction.channelId ?? undefined,
          messageId: undefined,
          authorId: interaction.user?.id,
        });

        if (result.exitCode !== 0) {
          await interaction.editReply("❌ Briefing failed: CLI returned an error");
          return;
        }

        if (result.stdout.length === 0) {
          await interaction.editReply("No briefing output received.");
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

        await editReplyWithPossibleAttachment(
          interaction,
          `📝 Briefing for: \`${query}\``,
          briefingText,
          `briefing-${query.replace(/[^a-z0-9\-]/gi, "_")}.md`
        );

        try {
          const posted = (await interaction.fetchReply()) as any;
          if (posted && typeof posted.id === "string") {
            suppressEmbedsIfPermitted(posted as Message).catch(() => {});
          }
        } catch {
          // ignore
        }
      } catch (error) {
        if (error instanceof CliRunnerError) {
          await interaction.reply({ content: "⚠️ Briefing failed because the OpenBrain CLI is unavailable or returned an error.", ephemeral: true });
        } else {
          await interaction.reply({ content: "⚠️ An unexpected error occurred while generating the briefing.", ephemeral: true });
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
          await message.reply(`❌ Failed to queue URL\n\n${CLI_UNAVAILABLE_MESSAGE}`);
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
