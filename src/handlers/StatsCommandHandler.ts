import type { CommandInteraction } from "discord.js";
import { runStatsCommand, type StatsResult } from "../bot/cli-runner.js";
import type { SlashCommandHandler } from "../interfaces/command-handler.js";

const DEFAULT_ERROR_MESSAGE = "❌ Failed to retrieve OpenBrain statistics. Please try again.";

export interface StatsCommandHandlerDependencies {
  runStats?: typeof runStatsCommand;
  errorMessage?: string;
}

export class StatsCommandHandler implements SlashCommandHandler {
  private readonly runStats: typeof runStatsCommand;
  private readonly errorMessage: string;

  constructor(dependencies: StatsCommandHandlerDependencies = {}) {
    this.runStats = dependencies.runStats ?? runStatsCommand;
    this.errorMessage = dependencies.errorMessage ?? DEFAULT_ERROR_MESSAGE;
  }

  async handleCommand(command: CommandInteraction): Promise<boolean> {
    if (command.commandName !== "stats") {
      return false;
    }

    await command.deferReply();

    try {
      const stats = await this.runStats({
        channelId: command.channelId ?? undefined,
        messageId: command.id,
        authorId: command.user?.id,
      });

      await command.editReply(this.formatStatsMessage(stats));
    } catch {
      await command.editReply(this.errorMessage);
    }

    return true;
  }

  private formatStatsMessage(stats: StatsResult): string {
    const totalLinks = stats.totalLinks;
    const processedCount = stats.processedCount;
    const pendingCount = stats.pendingCount;
    const failedCount = stats.failedCount;
    const successRate = totalLinks > 0 ? ((processedCount / totalLinks) * 100).toFixed(1) : "0.0";

    return [
      "📊 OpenBrain statistics",
      "",
      `Total links: ${totalLinks.toLocaleString()}`,
      `Processed: ${processedCount.toLocaleString()}`,
      `Pending: ${pendingCount.toLocaleString()}`,
      `Failed: ${failedCount.toLocaleString()}`,
      `Success rate: ${successRate}%`,
    ].join("\n");
  }
}
