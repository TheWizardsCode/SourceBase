import {
  ApplicationCommandOptionType,
  Client,
  GatewayIntentBits,
  type Interaction,
  type Message,
} from "discord.js";

import type { Logger } from "../log/index.js";

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
  readonly client: Client;

  constructor(private readonly options: DiscordBotOptions) {
    // discord.js v14 uses GatewayIntentBits (v13 used Intents.FLAGS).
    // Staying on v14 also removes the legacy transitive dependency path that
    // emitted Node DEP0040 punycode deprecation warnings at startup.
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ]
    });
  }

  getClient(): Client {
    return this.client;
  }

  private startupDone = false;

  private handleReady(client: any): void {
    if (this.startupDone) return;
    this.startupDone = true;

    this.options.logger.info("Discord bot connected", {
      userTag: client.user.tag,
      monitoredChannelId: this.options.monitoredChannelId
    });

    this.registerSlashCommands();
  }

  async start(): Promise<void> {
    this.client.once("clientReady", (client) => {
      this.handleReady(client);
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

      // Register the search command
      // Keep explicit option enums for v14 compatibility and readability.
      await guild.commands.create({
        name: "search",
        description: "Search OpenBrain for relevant items",
        options: [
          {
            name: "query",
            description: "Search query text",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "limit",
            description: "Maximum number of results to return (1-20)",
            type: ApplicationCommandOptionType.Integer,
            required: false,
          },
        ],
      });

      // Register the briefing command
      await guild.commands.create({
        name: "briefing",
        description: "Generate a briefing using the OpenBrain CLI",
        options: [
          {
            name: "query",
            description: "Query or URL to generate a briefing for",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "k",
            description: "Number of items to include in briefing (1-50)",
            type: ApplicationCommandOptionType.Integer,
            required: false,
            minValue: 1,
            maxValue: 50,
          },
        ],
      });

      // Register the recent command
      await guild.commands.create({
        name: "recent",
        description: "List recently modified OpenBrain items",
        options: [
          {
            name: "limit",
            description: "Maximum number of recent items to return (1-100)",
            type: ApplicationCommandOptionType.Integer,
            required: false,
            minValue: 1,
            maxValue: 100,
          },
        ],
      });

      // Register the add command
      await guild.commands.create({
        name: "add",
        description: "Add a URL or raw text to OpenBrain (use a file:// URL for local files)",
        options: [
          {
            name: "input",
            description: "URL or text to add to OpenBrain",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      });

      // Register the show_summary command (human-readable summary)
      await guild.commands.create({
        name: "show_summary",
        description: "Show a human-readable summary of an OpenBrain item by ID or URL",
        options: [
          {
            name: "input",
            description: "Item ID or URL to show",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      });

      // Register the show_full command (human-readable full output)
      await guild.commands.create({
        name: "show_full",
        description: "Show the full human-readable output for an OpenBrain item (ob show <url> --full)",
        options: [
          {
            name: "input",
            description: "Item ID or URL to show",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      });

      this.options.logger.info("Slash commands registered successfully");
    } catch (error) {
      this.options.logger.error("Failed to register slash commands", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
