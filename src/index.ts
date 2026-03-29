import { Client, Intents, TextChannel, type Message } from "discord.js";
import { execFile } from "child_process";
import { botConfig as config } from "./config/bot.js";
import { Logger } from "./logger.js";
import { DiscordBot } from "./discord/client.js";
import { isLikelyContentQuery } from "./query/detector.js";

// ============================================================================
// Logger
// ============================================================================

const logger = new Logger(config.LOG_LEVEL as any);

// ============================================================================
// Progress Message Formatting
// ============================================================================

// Note: URL processing via CLI subprocess has been removed as part of CLI extraction.
// The CLI is now maintained in the openBrain repository.
// Bot functionality is currently limited to Discord integration.

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
 * Run the OpenBrain CLI with a set of args.
 * Tries a couple of common binary names if OPENBRAIN_CLI_PATH isn't set.
 */
async function runOpenBrainCommand(args: string[]) {
  const tried = [process.env.OPENBRAIN_CLI_PATH || "OpenBrain", "openbrain"];

  for (const cmd of tried) {
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
          if (err) return reject({ err, stdout: stdout ?? "", stderr: stderr ?? "" });
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      });

      logger.info("OpenBrain command succeeded", { cmd, args, stdout });
      return { success: true, stdout, stderr, command: cmd };
    } catch (e: any) {
      const err = e?.err ?? null;
      const stdout = e?.stdout ?? "";
      const stderr = e?.stderr ?? "";

      // If the binary isn't found try the next candidate
      if (err && err.code === "ENOENT") {
        logger.debug("OpenBrain binary not found, trying next", { cmd });
        continue;
      }

      // Other errors are terminal for this invocation
      const message = err && err.message ? err.message : String(e);
      logger.error("OpenBrain command failed", { cmd, args, message, stdout, stderr });
      return { success: false, error: message, stdout, stderr, command: cmd };
    }
  }

  const triedList = tried.join(", ");
  const msg = `OpenBrain CLI not found on PATH. Tried: ${triedList}`;
  logger.error(msg);
  return { success: false, error: msg, stdout: "", stderr: "", command: tried[0] };
}

async function addUrlToOpenBrain(url: string, message: Message) {
  const tags = ["--tag", "source:discord", "--tag", `channel:${message.channelId}`];
  const args: string[] = [];
  if ((config.LOG_LEVEL as string) === "debug") {
    args.push("--verbose");
  }
  args.push("add");
  args.push(...tags);
  args.push(url);

  return await runOpenBrainCommand(args);
}

async function queueUrlWithOpenBrain(url: string, message: Message) {
  const tags = ["--tag", "source:discord", "--tag", `channel:${message.channelId}`];
  const args: string[] = [];
  if ((config.LOG_LEVEL as string) === "debug") {
    args.push("--verbose");
  }
  args.push("queue");
  args.push(...tags);
  args.push(url);

  return await runOpenBrainCommand(args);
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

// ============================================================================
// Bot Initialization
// ============================================================================

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
  onInteraction: async (interaction) => {
    if (!interaction.isCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === "stats") {
      await interaction.reply("Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository.");
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

      // Try to queue via OpenBrain CLI first
      const queued = await queueUrlWithOpenBrain(seed, message);
      if (queued.success) {
        // Wrap in code ticks to avoid Discord creating an embed in the reply
        await message.reply(`Queued URL for crawling: \`${seed}\``);
      } else {
        // Wrap the URL in angle brackets to prevent Discord creating embeds,
        // and leave a blank line before the echoed error message.
        await message.reply(`Failed to queue URL <${seed}>\n\n${queued.error || "OpenBrain CLI not available"}`);
      }

      return;
    }

    // Extract URLs from message
    const urls = extractUrls(message.content);
    if (urls.length > 0) {
      logger.info("Found URLs in message", { urls, messageId: message.id });
      // Attempt to suppress embeds on the original message if permitted.
      await suppressEmbedsIfPermitted(message);

      // Add URLs to OpenBrain (best-effort)
      for (const url of urls) {
        const res = await addUrlToOpenBrain(url, message);
        if (res.success) {
          // Wrap the URL in backticks to avoid creating an embed in the bot reply
          await message.reply(`Added URL to OpenBrain: \`${url}\``);
        } else {
          // If CLI isn't available, inform the user once. Wrap URL and add a blank line
          // before the error to avoid Discord auto-embedding the URL.
          await message.reply(`Could not add URL <${url}>\n\n${res.error || "OpenBrain CLI not available"}`);
        }
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
