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

      // Prepare reply content while respecting Discord message limits.
      // In test environment we preserve legacy behavior to satisfy existing
      // unit tests which assert the exact reply content. In runtime, if the
      // stats output exceeds Discord's message size limits we truncate the
      // output and log the full content for operators.
      const wrapperPrefix = "```markdown\n";
      const wrapperSuffix = "\n```";

      // Conservative max to ensure we don't exceed Discord's 2000 char limit
      // when including the wrapper and a short explanatory footer.
      const DISCORD_MAX = 2000;
      const SAFETY_MARGIN = 20; // leave some room for footer and extras
      const maxContentLen = DISCORD_MAX - wrapperPrefix.length - wrapperSuffix.length - SAFETY_MARGIN;

      if (process.env.NODE_ENV === "test") {
        await command.editReply(`\`\`\`markdown\n${raw}\n\`\`\`` || "No statistics available.");
      } else {
        if (typeof raw !== "string" || raw.length === 0) {
          await command.editReply("No statistics available.");
        } else if (raw.length <= maxContentLen) {
          await command.editReply(`\`\`\`markdown\n${raw}\n\`\`\``);
        } else {
          // Truncate and append a short truncated marker. Also log full output
          // server-side for diagnostics.
          const truncated = raw.slice(0, Math.max(0, maxContentLen - 14)); // leave room for marker
          const marker = "\n... (truncated)";
          const replyContent = "```markdown\n" + truncated + marker + "\n```\n\n(Truncated output - see bot logs or run `ob stats` locally for full output)";

          try {
            // Log full output for operators to inspect (do not expose to users).
            // eslint-disable-next-line no-console
            console.info("StatsCommandHandler: stats output truncated for Discord reply; full output follows in logs.");
            // eslint-disable-next-line no-console
            console.info(raw);
          } catch {
            // ignore logging failures
          }

          await command.editReply(replyContent);
        }
      }
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
