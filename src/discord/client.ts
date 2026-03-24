import { Client, Intents, Message, Interaction, CommandInteraction } from "discord.js";

import type { Logger } from "../logger.js";

type MessageHandler = (message: Message) => Promise<void>;
type InteractionHandler = (interaction: Interaction) => Promise<void>;

export interface DiscordBotOptions {
  token: string;
  monitoredChannelId: string;
  logger: Logger;
  onMonitoredMessage: MessageHandler;
  onInteraction?: InteractionHandler;
}

export class DiscordBot {
  private readonly client: Client;

  constructor(private readonly options: DiscordBotOptions) {
    this.client = new Client({
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT]
    });
  }

  async start(): Promise<void> {
    this.client.once("ready", async (client) => {
      this.options.logger.info("Discord bot connected", {
        userTag: client.user.tag,
        monitoredChannelId: this.options.monitoredChannelId
      });

      // Register slash commands
      await this.registerSlashCommands();
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

    this.client.on("interactionCreate", async (interaction) => {
      if (this.options.onInteraction) {
        await this.options.onInteraction(interaction);
      }
    });

    await this.client.login(this.options.token);
  }

  private async registerSlashCommands(): Promise<void> {
    try {
      const guild = this.client.guilds.cache.first();
      if (!guild) {
        this.options.logger.warn("No guild found to register slash commands");
        return;
      }

      // Register the stats command
      await guild.commands.create({
        name: "stats",
        description: "Get database and embedding statistics",
      });

      this.options.logger.info("Slash commands registered successfully");
    } catch (error) {
      this.options.logger.error("Failed to register slash commands", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
