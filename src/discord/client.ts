import { Client, Intents, Message } from "discord.js";

import type { Logger } from "../logger.js";

type MessageHandler = (message: Message) => Promise<void>;

export interface DiscordBotOptions {
  token: string;
  monitoredChannelId: string;
  logger: Logger;
  onMonitoredMessage: MessageHandler;
}

export class DiscordBot {
  private readonly client: Client;

  constructor(private readonly options: DiscordBotOptions) {
    this.client = new Client({
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT]
    });
  }

  async start(): Promise<void> {
    this.client.once("ready", (client) => {
      this.options.logger.info("Discord bot connected", {
        userTag: client.user.tag,
        monitoredChannelId: this.options.monitoredChannelId
      });
    });

    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) {
        return;
      }

      if (message.channelId !== this.options.monitoredChannelId) {
        return;
      }

      await this.options.onMonitoredMessage(message);
    });

    await this.client.login(this.options.token);
  }
}
