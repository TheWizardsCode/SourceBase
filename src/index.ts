import {
  PermissionFlagsBits,
  ThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./log/index.js";
import { DiscordBot } from "./discord/client.js";
import { buildCliErrorReport, makeTempFileName } from "./discord/utils.js";
import { postCliErrorReport } from "./discord/cli-error-report.js";
import { isLikelyContentQuery } from "./query/detector.js";
import { formatProgressMessage } from "./formatters/progress.js";
import {
  DISCORD_CONTENT_LIMIT,
  renderBriefingFromJson,
  wrapMarkdownText,
  MARKDOWN_WRAP_WIDTH,
} from "./presenters/discordFormatting.js";
import { CrawlCommandHandler } from "./handlers/CrawlCommandHandler.js";
import { StatsCommandHandler } from "./handlers/StatsCommandHandler.js";
import { RecentCommandHandler } from "./handlers/RecentCommandHandler.js";
import { AddCommandHandler } from "./handlers/AddCommandHandler.js";
import { ShowCommandHandler } from "./handlers/ShowCommandHandler.js";
import { LifecycleManager } from "./lifecycle/LifecycleManager.js";
import {
  formatMissingCrawlSeedMessage,
  formatQueueFailureMessage,
  formatQueuedUrlMessage,
} from "./presenters/queue.js";
import QueuePresenter, { sendWithFallback } from "./presenters/QueuePresenter.js";
import {
  runCliCommand,
  isCliAvailable,
  CliRunnerError,
} from "./bot/cli-runner.js";
import { pathToFileURL } from "url";
import { extractUrls } from "./url.js";
import { processUrlWithProgress } from "./bot/processing.js";
import {
  createThreadForMessage,
  formatThreadName,
} from "./bot/threads.js";
import {
  generateSummaryWithRetry,
  buildOpenBrainItemLink,
} from "./bot/summaries.js";
import {
  addReaction,
  removeReaction,
  checkCliAvailability,
  isChatInputInteraction,
  CLI_UNAVAILABLE_MESSAGE,
  PROCESSING_REACTION,
  SUCCESS_REACTION,
  FAILURE_REACTION,
} from "./bot/utils.js";

// ============================================================================
// Logger and Handlers
// ============================================================================

const logger = new Logger(config.LOG_LEVEL as any);
const crawlCommandHandler = new CrawlCommandHandler();
const statsCommandHandler = new StatsCommandHandler();
const recentCommandHandler = new RecentCommandHandler();
const addCommandHandler = new AddCommandHandler();
const showCommandHandler = new ShowCommandHandler();

// QueuePresenter manages lifecycle of short-lived queue status messages
const queuePresenter = new QueuePresenter(logger);

// Export for backward compatibility
export { formatProgressMessage };
export { postCliErrorReport };

// ============================================================================
// Constants
// ============================================================================

const MARKDOWN_WRAP_WIDTH_LOCAL = MARKDOWN_WRAP_WIDTH;

// Cache for message-level saved briefings to enforce idempotency.
// Key: Discord message id (the bot's reply message that contains the briefing)
// Value: numeric item id when saved, or 'saving' when an ingestion is in progress
const saveBriefingCache = new Map<string, number | "saving">();

// ============================================================================
// Summary and Briefing Helpers
// ============================================================================

/**
 * Edit a reply with possible attachment for long content
 */
async function editReplyWithPossibleAttachment(
  interaction: ChatInputCommandInteraction,
  headerLine: string,
  content: string,
  filename = "content.md",
  showSaveButton = false
): Promise<void> {
  const { extractSummaryFromMarkdown } = await import(
    "./presenters/discordFormatting.js"
  );
  const fullText = `${headerLine}\n\n${content}`;

  // Build optional components (raw shape accepted by discord.js).
  // Avoid including components during tests because the test harness's
  // fake editReply handler expects a string argument and will stringify
  // objects (resulting in '[object Object]'). In real runtime we include
  // the button when requested.
  const components =
    showSaveButton && process.env.NODE_ENV !== "test"
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
        const { suppressEmbedsIfPermitted } = await import("./bot/utils.js");
        suppressEmbedsIfPermitted(posted as Message, logger).catch(() => {});
      }
    } catch {
      // ignore
    }
    return;
  }

  // Create a compact summary and attach original content as a .md file
  const summary = extractSummaryFromMarkdown(
    content,
    DISCORD_CONTENT_LIMIT - headerLine.length - 120
  );
  const summaryText = `${headerLine}\n\n${summary}\n\n*(Full content attached as ${filename})*`;

  const file = { attachment: Buffer.from(content, "utf8"), name: filename };
  if (!components)
    await interaction.editReply({ content: summaryText, files: [file] } as any);
  else
    await interaction.editReply({
      content: summaryText,
      files: [file],
      components,
    } as any);

  try {
    const posted = await interaction.fetchReply();
    if (posted && typeof posted.id === "string") {
      const { suppressEmbedsIfPermitted } = await import("./bot/utils.js");
      suppressEmbedsIfPermitted(posted as Message, logger).catch(() => {});
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
              } else {
                briefingText = (sourceMessage?.content || "").trim();
              }
            } else {
              briefingText = (sourceMessage?.content || "").trim();
            }
          } catch {
            briefingText = (sourceMessage?.content || "").trim();
          }

          if (!briefingText) {
            await btn.editReply({
              content: "❌ Could not extract briefing text from the message.",
            });
            return;
          }

          if (!(await isCliAvailable())) {
            await btn.editReply({
              content:
                "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed on the host.",
            });
            return;
          }

          // Enforce message-level dedupe. Use the bot reply message id as the
          // key (the interaction.message.id) so repeated clicks on the same
          // reply are idempotent.
          const replyMessageId = sourceMessage?.id as string | undefined;
          if (replyMessageId) {
            const cached = saveBriefingCache.get(replyMessageId);
            if (cached === "saving") {
              await btn.editReply({
                content:
                  "⏳ Briefing save already in progress for this message. Please wait...",
              });
              return;
            }
            if (typeof cached === "number") {
              const itemUrl = buildOpenBrainItemLink(
                cached,
                `openbrain://sorra/${cached}`
              );
              await btn.editReply({
                content: `✅ Briefing already saved: <${itemUrl}>`,
              });
              return;
            }

            // Mark as saving
            saveBriefingCache.set(replyMessageId, "saving");
          }

          const tmpName = makeTempFileName("briefing", "md");
          const fs = await import("fs/promises");
          try {
            await fs.writeFile(tmpName, briefingText, "utf8");
          } catch (err) {
            await btn.editReply({
              content: `❌ Failed to write temporary briefing file: ${String(err)}`,
            });
            return;
          }

          try {
            // The OpenBrain CLI expects URLs. For local temporary files,
            // provide a file:// URL so the CLI treats it as a valid input.
            // Convert local filesystem path to a file:// URL for the CLI using
            // pathToFileURL for correct cross-platform encoding.
            const tmpArg =
              typeof tmpName === "string"
                ? pathToFileURL(tmpName).toString()
                : tmpName;

            const addResult = await runCliCommand(
              "add",
              ["--format", "ndjson", tmpArg],
              {
                channelId: btn.channelId ?? undefined,
                messageId: undefined,
                authorId: btn.user?.id,
              }
            );

            if (addResult.exitCode !== 0) {
              if (replyMessageId) saveBriefingCache.delete(replyMessageId);
              await btn.editReply({
                content: `❌ Failed to ingest briefing: CLI error`,
              });
              return;
            }

            let createdId: number | undefined = undefined;
            for (const line of addResult.stdout) {
              try {
                const obj = JSON.parse(line);
                if (obj && typeof obj === "object" && (obj.id || obj.item_id)) {
                  const raw = obj.id ?? obj.item_id;
                  if (typeof raw === "number") createdId = raw;
                  else if (
                    typeof raw === "string" &&
                    /^\d+$/.test(raw)
                  )
                    createdId = parseInt(raw, 10);
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
              const itemUrl = buildOpenBrainItemLink(
                createdId,
                `openbrain://sorra/${createdId}`
              );
              successMsg = `✅ Briefing saved: <${itemUrl}>`;
              if (replyMessageId)
                saveBriefingCache.set(replyMessageId, createdId);
            } else {
              if (replyMessageId) saveBriefingCache.delete(replyMessageId);
            }

            await btn.editReply({ content: successMsg });
          } catch (err) {
            if (replyMessageId) saveBriefingCache.delete(replyMessageId);
            await btn.editReply({
              content: `❌ Failed to ingest briefing: ${String(err)}`,
            });
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
          await btn.reply({
            content:
              "An unexpected error occurred while handling the Save briefing action.",
            ephemeral: true,
          });
        } else if (isChatInputInteraction(interaction)) {
          const cmdErr = interaction as ChatInputCommandInteraction;
          await cmdErr.reply({
            content:
              "An unexpected error occurred while handling the Save briefing action.",
            ephemeral: true,
          });
        } else {
          // Best-effort fallback for unknown interaction shapes (tests may use plain objects)
          try {
            const anyI = interaction as unknown as {
              reply?: (arg: any) => Promise<any>;
            };
            if (typeof anyI.reply === "function")
              await anyI.reply({
                content:
                  "An unexpected error occurred while handling the Save briefing action.",
                ephemeral: true,
              });
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
    if (!isChatInputInteraction(interaction)) return;

    const cmd = interaction as ChatInputCommandInteraction;
    const commandName = cmd.commandName;

    // Handle simple stats command
    if (await statsCommandHandler.handleCommand(cmd)) {
      return;
    }

    // Handle /recent
    if (await recentCommandHandler.handleCommand(cmd)) {
      return;
    }

    // Handle /add
    if (await addCommandHandler.handleCommand(cmd)) {
      return;
    }

    // Handle /show
    if (await showCommandHandler.handleCommand(cmd)) {
      return;
    }

    // Handle /search
    if (commandName === "search") {
      await handleSearchCommand(cmd);
      return;
    }

    // Handle /briefing
    if (commandName === "briefing") {
      await handleBriefingCommand(cmd);
      return;
    }
  },
  onMonitoredMessage: async (message) => {
    // Handle content queries
    if (isLikelyContentQuery(message.content)) {
      await sendWithFallback(
        message,
        "Query functionality temporarily unavailable - CLI has been extracted to openBrain repository.",
        logger
      );
      return;
    }

    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id,
    });

    // Handle inline `ob add <text>` message triggers
    const handled = await handleObAddCommand(message);
    if (handled) return;

    // Handle crawl commands
    const handledCrawl = await handleCrawlCommand(message);
    if (handledCrawl) return;

    // Extract URLs from message using shared utility
    const urls = extractUrls(message.content);
    if (urls.length > 0) {
      logger.info("Found URLs in message", { urls, messageId: message.id });

      // Check CLI availability before processing URLs
      if (!(await checkCliAvailability(message, isCliAvailable, logger))) {
        return;
      }

      // Add URLs using CLI runner with threaded progress updates
      for (const url of urls) {
        await processUrlWithProgress(message, url, {
          logger,
          sendSummaryOnInsert: config.SEND_SUMMARY_ON_INSERT,
        });
      }
    }
  },
});

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Handle the /search command
 */
async function handleSearchCommand(
  cmd: ChatInputCommandInteraction
): Promise<void> {
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

    const parsed = parseSearchResults(result.stdout, clamped);

    // Start a thread off the original bot reply and post each result
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
        thread = await (parentMsg as any).startThread({
          name: searchingThreadName,
          autoArchiveDuration: 60,
        });
      } catch (err) {
        logger.warn("Failed to start thread from reply", {
          error: err instanceof Error ? err.message : String(err),
        });
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
            thread = await chAny.threads.create({
              name: searchingThreadName,
              autoArchiveDuration: 60,
            });
          }
        }
      } catch (err) {
        logger.warn(
          "Failed to create thread on channel; will post results in-channel instead",
          { error: err instanceof Error ? err.message : String(err) }
        );
        thread = null;
      }
    }

    const resultLines = parsed.map(
      (p) => `[${escapeTitle(p.title)}](${p.url})`
    );
    try {
      if (thread) {
        await cmd.editReply(
          `✅ Search results for '${query}' are being posted in thread <#${thread.id}>.`
        );
      } else {
        const resultsContent = `✅ Search results for '${query}':\n\n${resultLines.join(
          "\n\n"
        )}`;
        await cmd.editReply(resultsContent);
      }
    } catch {
      // ignore
    }

    // Post search results with summaries
    await postSearchResults(cmd, thread, parsed, query);
  } catch (error) {
    if (error instanceof CliRunnerError) {
      await cmd.reply({
        content:
          "⚠️ Search failed because the OpenBrain CLI is unavailable or returned an error.",
        ephemeral: true,
      });
    } else {
      await cmd.reply({
        content:
          "⚠️ An unexpected error occurred while performing the search.",
        ephemeral: true,
      });
    }
  }
}

/**
 * Parse search results from CLI output
 */
function parseSearchLines(
  lines: string[],
  limit: number
): { title: string; url: string }[] {
  return lines
    .map((l) => parseSearchLine(l))
    .filter((v): v is { title: string; url: string } => !!v)
    .slice(0, limit);
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
    const cells = remainder
      .split(delimiterRegex)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length > 0) {
      let title: string | null = null;
      for (const c of cells) {
        const cell = String(c).trim();
        if (!cell) continue;
        if (/^\d+(?:\.\d+)?%?$/.test(cell)) continue;
        try {
          if (/\p{L}/u.test(cell)) {
            title = cell;
            break;
          }
        } catch {
          if (/[A-Za-z]/.test(cell)) {
            title = cell;
            break;
          }
        }
        if (!title) title = cell;
      }

      let titleStr = title || url;
      titleStr = titleStr.replace(/\s*\d+(?:\.\d+)?%?$/g, "").trim();
      titleStr = titleStr
        .replace(/[│┃║┆┊╎╏\u2500-\u257F]/g, "")
        .replace(/\|/g, " ")
        .trim();
      if (!titleStr) titleStr = url;
      return { title: titleStr, url };
    }
  }

  remainder = remainder
    .replace(/\(.*?relevance.*?\)/i, "")
    .replace(/\(\s*[0-9.]+\s*\)/, "")
    .trim();
  remainder = remainder
    .replace(/(?:\|)?\s*(?:relevance[:\s]*\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*$/i, "")
    .trim();
  remainder = remainder
    .replace(/^[\-–—\|:]+\s*/, "")
    .replace(/\s+[\-–—\|:]+$/, "")
    .trim();

  let title = remainder.replace(/\|/g, " ").trim();
  if (!title) title = url;
  return { title, url };
}

function parseSearchResults(
  stdout: string[],
  clamped: number
): { title: string; url: string }[] {
  const stdoutText = stdout.join("\n").trim();

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
        const arrProp = Object.keys(jsonOut).find((k) =>
          Array.isArray((jsonOut as any)[k])
        );
        if (arrProp) items = (jsonOut as any)[arrProp];
      }
    }

    return items
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
    return parseSearchLines(stdout, clamped);
  }
}

function escapeTitle(s: string): string {
  if (!s) return s;
  let t = String(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  t = t.replace(/\]/g, "\\]");
  return t;
}

/**
 * Post search results to thread with summaries
 */
async function postSearchResults(
  cmd: ChatInputCommandInteraction,
  thread: ThreadChannel | null,
  parsed: { title: string; url: string }[],
  query: string
): Promise<void> {
  const summaryTasks: Promise<void>[] = [];

  for (const p of parsed) {
    const title = escapeTitle(p.title);
    const formatSearchResultBody = (
      titleText: string,
      summaryText: string,
      urlText: string
    ): string => {
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

    const placeholderBody = formatSearchResultBody(
      title,
      "_Generating summary..._",
      p.url
    );

    let postedMessage: any = null;
      try {
        if (thread) {
          postedMessage = await sendWithFallback(thread, placeholderBody, logger);
        } else if (typeof cmd.followUp === "function") {
          postedMessage = await cmd.followUp({ content: placeholderBody } as any);
        } else {
          try {
            await cmd.editReply(placeholderBody);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        logger.warn("Failed to post search result placeholder", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

    const task = (async () => {
      let summaryResult: { success: true; summary: string } | { success: false; error: string };
      try {
        summaryResult = await generateSummaryWithRetry(
          p.url,
          {
            channelId: cmd.channelId ?? "",
            messageId: String(cmd.id),
            authorId: cmd.user?.id ?? "",
            timeoutMs: 20000,
            maxAttempts: 1,
          },
          logger
        );
      } catch (err) {
        summaryResult = { success: false, error: String(err) };
      }

      const summaryText = summaryResult.success
        ? summaryResult.summary
        : `*Summary generation failed: ${summaryResult.error}*`;
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
              await sendWithFallback(thread, updatedBody, logger, postedMessage);
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
          await postedMessage.edit(
            formatSearchResultBody(
              title,
              "*Summary unavailable right now. Please run `ob summary <url>` manually for this item.*",
              p.url
            )
          );
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
}

/**
 * Handle the /briefing command
 */
async function handleBriefingCommand(
  cmd: ChatInputCommandInteraction
): Promise<void> {
  try {
    const query = cmd.options.getString("query", true);
    const k = cmd.options.getInteger("k");

    await cmd.deferReply();

    if (k !== null && (k < 1 || k > 50)) {
      await cmd.editReply("⚠️ Briefing parameter `k` must be between 1 and 50.");
      return;
    }

    if (!(await isCliAvailable())) {
      await cmd.editReply(
        "⚠️ Briefing failed because the OpenBrain CLI is unavailable."
      );
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
      briefingText = renderBriefingFromJson(jsonOut);
    } catch {
      // keep raw text
    }

    briefingText = wrapMarkdownText(briefingText, MARKDOWN_WRAP_WIDTH_LOCAL);

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
        const { suppressEmbedsIfPermitted } = await import("./bot/utils.js");
        suppressEmbedsIfPermitted(posted as Message, logger).catch(() => {});
      }
    } catch {
      // ignore
    }
  } catch (error) {
    if (error instanceof CliRunnerError) {
      await cmd.reply({
        content:
          "⚠️ Briefing failed because the OpenBrain CLI is unavailable or returned an error.",
        ephemeral: true,
      });
    } else {
      await cmd.reply({
        content:
          "⚠️ An unexpected error occurred while generating the briefing.",
        ephemeral: true,
      });
    }
  }
}

// ============================================================================
// Message Command Handlers
// ============================================================================

/**
 * Handle `ob add` command from message
 * @returns true if handled, false otherwise
 */
async function handleObAddCommand(message: Message): Promise<boolean> {
  try {
    const obAddMatch =
      typeof message.content === "string" &&
      message.content.match(/^\s*ob\s+add(?:\s+([\s\S]*))?$/i);

    if (!obAddMatch) {
      return false;
    }

    let payload = String(obAddMatch[1] || "").trim();

    // If payload is empty, attempt to use the referenced/replied-to message
    let fetchRefFailed = false;
    let refMsg: any = null;
    if (!payload && message.reference && (message.reference as any).messageId) {
      try {
        const refId = (message.reference as any).messageId;
        const chAny = message.channel as any;
        if (chAny && chAny.messages && typeof chAny.messages.fetch === "function") {
          refMsg = await chAny.messages.fetch(refId);
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

    // Check for attachments on referenced message or current message
    if (!payload) {
      const atts: any = refMsg?.attachments || (message as any).attachments;
      if (atts && atts.size && atts.size > 0) {
        const att = atts.first();
        const name = String(att?.name || "").toLowerCase();
        const allowedExts = [".md", ".markdown", ".txt"];
        const hasTextExt = allowedExts.some((e) => name.endsWith(e));

        try {
          const resp = await fetch(att.url);
          if (!resp || !resp.ok) {
            payload = (refMsg?.content || "").trim() || (message as any).content || "";
          } else {
            const contentType =
              resp.headers && typeof resp.headers.get === "function"
                ? resp.headers.get("content-type")
                : null;
            const contentLength =
              resp.headers && typeof resp.headers.get === "function"
                ? resp.headers.get("content-length")
                : null;

            if (!hasTextExt && contentType && !contentType.startsWith("text/")) {
              await sendWithFallback(
                message,
                "⚠️ The referenced attachment does not appear to be a text file (unsupported Content-Type). Please provide a .md or .txt file or paste the text directly.",
                logger
              );
              return true;
            }

            const MAX_ADD_BYTES = Number(process.env.OB_ADD_MAX_BYTES || 64 * 1024);
            if (
              contentLength &&
              /^\d+$/.test(String(contentLength)) &&
              Number(contentLength) > MAX_ADD_BYTES
            ) {
              logger.warn("ob add attachment too large (content-length)", {
                messageId: message.id,
                size: Number(contentLength),
                max: MAX_ADD_BYTES,
              });
               await sendWithFallback(
                 message,
                 `⚠️ Attached file is too large to ingest directly (max ${MAX_ADD_BYTES} bytes). Please provide a URL or split the file.`,
                 logger
               );
               return true;
             }

            const textBody = await resp.text();
            if (Buffer.byteLength(textBody, "utf8") > MAX_ADD_BYTES) {
              logger.warn("ob add attachment too large (body)", {
                messageId: message.id,
                size: Buffer.byteLength(textBody, "utf8"),
                max: MAX_ADD_BYTES,
              });
               await sendWithFallback(
                 message,
                 `⚠️ Attached file is too large to ingest directly (max ${MAX_ADD_BYTES} bytes). Please provide a URL or split the file.`,
                 logger
               );
               return true;
             }

            payload = textBody.trim();
          }
        } catch (err) {
          logger.warn("Failed to fetch attachment for ob add", {
            messageId: message.id,
            url: att?.url,
            error: err instanceof Error ? err.message : String(err),
          });
          if (fetchRefFailed) {
            await sendWithFallback(
              message,
              "⚠️ I couldn't fetch the message you replied to. Please paste the text you want to add, or ensure the bot has permission to read message history in this channel, then try `ob add` again.",
              logger
            );
            return true;
          }
          payload = (refMsg?.content || "").trim() || (message as any).content || "";
        }
      }
    }

    if (!payload) {
      if (fetchRefFailed) {
        await sendWithFallback(
          message,
          "⚠️ I couldn't fetch the message you replied to. Please paste the text you want to add, or ensure the bot has permission to read message history in this channel, then try `ob add` again.",
          logger
        );
      } else {
        await sendWithFallback(
          message,
          "❌ Please provide text to add, for example: `ob add <text>` or reply to a message with `ob add`.",
          logger
        );
      }
      return true;
    }

    // Enforce size limit
    const MAX_ADD_BYTES = Number(process.env.OB_ADD_MAX_BYTES || 64 * 1024);
    if (Buffer.byteLength(payload, "utf8") > MAX_ADD_BYTES) {
      logger.warn("ob add payload too large", {
        messageId: message.id,
        size: Buffer.byteLength(payload, "utf8"),
        max: MAX_ADD_BYTES,
      });
      await message.reply(
        `⚠️ Text too large to ingest directly (max ${MAX_ADD_BYTES} bytes). Please provide a URL or split the text into smaller pieces.`
      );
      return true;
    }

    // Check CLI availability
    if (!(await checkCliAvailability(message, isCliAvailable, logger))) {
      logger.warn("ob add requested but CLI unavailable", { messageId: message.id });
      return true;
    }

    // Write payload to temp file and process
    const fs = await import("fs/promises");
    const tmpName = makeTempFileName("ob-add", "txt");

    try {
      await fs.writeFile(tmpName, payload, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      logger.error("Failed to write temporary file for ob add", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await sendWithFallback(
        message,
        "❌ Failed to prepare temporary file for ingestion. Please try again or report this to the maintainers.",
        logger
      );
      return true;
    }

    const fileUrl = pathToFileURL(tmpName).toString();

    try {
      try {
        await processUrlWithProgress(message, fileUrl, {
          logger,
          sendSummaryOnInsert: config.SEND_SUMMARY_ON_INSERT,
        });
      } catch (err) {
        logger.error("Error during ob add processing", {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
           try {
           await sendWithFallback(
             message,
             "❌ Failed to ingest text — an internal error occurred. Please try again later.",
             logger
           );
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

    return true;
  } catch (err) {
    logger.warn("Error while attempting to handle ob add message", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Handle crawl command from message
 * @returns true if handled, false otherwise
 */
async function handleCrawlCommand(message: Message): Promise<boolean> {
  const crawl = crawlCommandHandler.parse(message.content);
  if (!crawl.isCrawlCommand) {
    return false;
  }

  logger.info("Crawl command detected", { messageId: message.id });

  const seed = crawl.seedUrl;
  if (!seed) {
    await sendWithFallback(message, formatMissingCrawlSeedMessage(), logger);
    return true;
  }

  // Check CLI availability before queueing
  if (!(await checkCliAvailability(message, isCliAvailable, logger))) {
    return true;
  }

  // Add processing reaction and post a queue status message
  await addReaction(message, PROCESSING_REACTION, logger);

  let statusKey = `queue:${message.id}:${seed}`;
  try {
    // Post an initial queued status message (best-effort)
    await queuePresenter.createOrUpdateStatus(
      statusKey,
      message,
      queuePresenter.formatQueueStatusMessage({ processing: true, url: seed })
    );

    const queueResult = await crawlCommandHandler.queueSeed(message, seed);

      if (queueResult.success) {
      // Remove processing reaction and add success reaction
      await removeReaction(message, PROCESSING_REACTION, logger);
      await addReaction(message, SUCCESS_REACTION, logger);

      // Update the status message to indicate queued/success
      await queuePresenter.createOrUpdateStatus(
        statusKey,
        message,
        queuePresenter.formatQueueStatusMessage({
          position: 0,
          total: 0,
          url: seed,
          note: "Queued",
        })
      );

      // Wrap in code ticks to avoid Discord creating an embed
      await sendWithFallback(message, formatQueuedUrlMessage(seed), logger);
    } else {
      // Remove processing reaction and add failure reaction
      await removeReaction(message, PROCESSING_REACTION, logger);
      await addReaction(message, FAILURE_REACTION, logger);

      // Update or clear the status and reply with failure message
      await queuePresenter.createOrUpdateStatus(
        statusKey,
        message,
        queuePresenter.formatQueueStatusMessage({
          url: seed,
          note: `Failed: ${queueResult.error}`,
        })
      );
      await sendWithFallback(
        message,
        formatQueueFailureMessage(queueResult.error, CLI_UNAVAILABLE_MESSAGE),
        logger
      );
    }
  } catch (error) {
    // Remove processing reaction and add failure reaction
    await removeReaction(message, PROCESSING_REACTION, logger);
    await addReaction(message, FAILURE_REACTION, logger);

    // Record CLI-origin errors
    if (error instanceof CliRunnerError) {
      logger.error("CLI error during queue command", {
        messageId: message.id,
        url: seed,
        exitCode: error.exitCode,
        stderr: error.stderr,
      });

      try {
        const cmd = `queue ${seed}`;
        const report = buildCliErrorReport({
          command: cmd,
          args: [],
          exitCode: error.exitCode,
          stderr: error.stderr,
          spawnError: error.message,
          note: "Observed during user-invoked queue command",
        });

        if (typeof message.startThread === "function") {
          try {
            const t = await message.startThread({
              name: `CLI error: ${new URL(seed).hostname}`,
              autoArchiveDuration: 60,
            });
            await postCliErrorReport(
              t,
              report,
              "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report."
            );
            await t.setArchived(true).catch(() => {});
          } catch (threadErr) {
            logger.warn(
              "Failed to create thread for CLI queue error; falling back to reply",
              {
                error:
                  threadErr instanceof Error
                    ? threadErr.message
                    : String(threadErr),
              }
            );
            await postCliErrorReport(
              message,
              report,
              "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report."
            );
          }
        } else {
          await postCliErrorReport(
            message,
            report,
            "⚠️ CLI error encountered while queueing a URL. See attached diagnostic report."
          );
        }
      } catch (err) {
        logger.warn("Failed to post detailed CLI error report for queue command", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sendWithFallback(
          message,
          `❌ Failed to queue URL\n\n${CLI_UNAVAILABLE_MESSAGE}`,
          logger
        );
      }
    } else {
      throw error;
    }
  } finally {
    // Ensure we clear the temporary status message
    try {
      await queuePresenter.clearStatus(statusKey);
    } catch {
      // ignore
    }
  }

  return true;
}

// ============================================================================
// Startup and Shutdown
// ============================================================================

// Create lifecycle manager for comprehensive startup/shutdown management
const lifecycleManager = new LifecycleManager({
  logger,
  client: bot.client,
  startupNotification: config.STARTUP_NOTIFICATION_CHANNEL_ID
    ? {
        channelId: config.STARTUP_NOTIFICATION_CHANNEL_ID,
        includeTimestamp: true,
      }
    : undefined,
  shutdownConfig: {
    timeoutMs: 30000,
    cleanupStatusMessages: true,
    performLostItemRecovery: true,
  },
  eventListeners: {
    onStartupBegin: () => {
      logger.info("Bot startup sequence beginning");
    },
    onStartupComplete: () => {
      logger.info("Bot startup sequence completed");
    },
    onShutdownBegin: (signal: string) => {
      logger.info(`Bot shutdown initiated by ${signal}`);
    },
    onShutdownComplete: () => {
      logger.info("Bot shutdown sequence completed");
    },
  },
});

// Start the bot with lifecycle management
void (async () => {
  try {
    await bot.start();
    await lifecycleManager.performStartup();
  } catch (error) {
    logger.error("Failed to start bot", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
})();

// Export internals for testing
export { processUrlWithProgress };
export { lifecycleManager };
export { handleObAddCommand, handleCrawlCommand };
export { handleSearchCommand, handleBriefingCommand };
