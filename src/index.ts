import { config } from "./config.js";
import { DiscordBot } from "./discord/client.js";
import { Logger } from "./logger.js";

const logger = new Logger(config.LOG_LEVEL);

const bot = new DiscordBot({
  token: config.DISCORD_BOT_TOKEN,
  monitoredChannelId: config.DISCORD_CHANNEL_ID,
  logger,
  onMonitoredMessage: async (message) => {
    logger.info("Received monitored channel message", {
      messageId: message.id,
      authorId: message.author.id
    });
  }
});

bot.start().catch((error) => {
  logger.error("Bot startup failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
