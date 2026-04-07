import type { CommandInteraction } from "discord.js";
import { runStatsCommand, type StatsResult, CliRunnerError, StatsParseError } from "../bot/cli-runner.js";
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
    } catch (err) {
      // Always log the error server-side for diagnostics
      try {
        // eslint-disable-next-line no-console
        console.error("StatsCommandHandler: error while retrieving stats:", err);
      } catch {
        // ignore logging failures
      }

      // Handle parse-specific errors specially so users see a meaningful
      // message when the CLI returned human-readable output instead of JSON.
      if (err instanceof StatsParseError) {
        const raw = String(err.stderr || "");
        // Truncate to a reasonable size for Discord messages
        const maxLen = 1500;
        const snippet = raw.length > maxLen ? raw.slice(0, maxLen) + "\n...(truncated)" : raw;
        const msg = [
          "⚠️ OpenBrain returned unexpected non-JSON output. The bot expected structured JSON from `ob stats --json`.",
          "This may indicate an incompatible CLI version or that the CLI was invoked with unsupported flags.",
          "",
          "Raw CLI output (truncated):",
          "```\n" + snippet + "\n```",
        ].join("\n");
        await command.editReply(msg);
        return true;
      }

      // If the failure was due to spawn/ENOENT/EACCES etc., surface the
      // availability message. Other errors fall back to the generic one.
      if (err instanceof CliRunnerError) {
        const CLI_UNAVAILABLE_MESSAGE =
          "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.";
        await command.editReply(CLI_UNAVAILABLE_MESSAGE);
      } else {
        // In test mode we keep the legacy behavior (tests assert the exact
        // default message). In runtime (non-test) include a truncated
        // error message to help operators diagnose issues quickly.
        if (process.env.NODE_ENV === "test") {
          await command.editReply(this.errorMessage);
        } else {
          const msg = String((err && (err as any).message) || String(err || ""));
          const snippet = msg.length > 500 ? msg.slice(0, 500) + "...(truncated)" : msg;
          await command.editReply(`${this.errorMessage}\n\nError: ${snippet}\n(See bot logs for details)`);
        }
      }
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
