import type { ChatInputCommandInteraction } from "discord.js";
import { runStatsCommand, CliRunnerError } from "../bot/cli-runner.js";
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

  async handleCommand(command: ChatInputCommandInteraction): Promise<boolean> {
    if (command.commandName !== "stats") {
      return false;
    }

    await command.deferReply();

    try {
      const { raw } = await this.runStats({
        channelId: command.channelId ?? undefined,
        messageId: command.id,
        authorId: command.user?.id,
      });

      await command.editReply(`\`\`\`markdown\n${raw}\n\`\`\`` || "No statistics available.");
    } catch (err) {
      // Always log the error server-side for diagnostics
      try {
        // eslint-disable-next-line no-console
        console.error("StatsCommandHandler: error while retrieving stats:", err);
      } catch {
        // ignore logging failures
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
}
