import type { ChatInputCommandInteraction } from "discord.js";
import { runCliCommand, CliRunnerError } from "../bot/cli-runner.js";
import { DISCORD_CONTENT_LIMIT, truncate } from "../presenters/discordFormatting.js";
import type { SlashCommandHandler } from "../interfaces/command-handler.js";

const DEFAULT_ERROR_MESSAGE = "❌ Failed to show OpenBrain item. Please try again.";

export interface ShowCommandHandlerDependencies {
  runCli?: typeof runCliCommand;
  errorMessage?: string;
}

export class ShowCommandHandler implements SlashCommandHandler {
  private readonly runCli: typeof runCliCommand;
  private readonly errorMessage: string;

  constructor(deps: ShowCommandHandlerDependencies = {}) {
    this.runCli = deps.runCli ?? runCliCommand;
    this.errorMessage = deps.errorMessage ?? DEFAULT_ERROR_MESSAGE;
  }

  async handleCommand(command: ChatInputCommandInteraction): Promise<boolean> {
    const cmdName = command.commandName;
    if (cmdName !== "show_summary" && cmdName !== "show_full") return false;

    await command.deferReply();

    try {
      const input = command.options.getString("input", true).trim();

      // Decide CLI args: summary = ob show <input>, full = ob show <input> --full
      const args: string[] = [input];
      if (cmdName === "show_full") args.push("--full");

      const result = await this.runCli("show", args, {
        channelId: command.channelId ?? undefined,
        messageId: undefined,
        authorId: command.user?.id,
      } as any);

      if (result.exitCode !== 0) {
        await command.editReply("❌ Show failed: CLI returned an error");
        return true;
      }

      if (!result.stdout || result.stdout.length === 0) {
        await command.editReply("No output received for the requested item.");
        return true;
      }

      const stdoutText = result.stdout.join("\n").trim();

      // Treat output as human-readable text. If it's short, send inline; if
      // large, attach as a file. Use centralized content limit.
      if (stdoutText.length <= DISCORD_CONTENT_LIMIT) {
        await command.editReply(stdoutText);
      } else {
        const file = { attachment: Buffer.from(stdoutText, "utf8"), name: `show-${Date.now()}.txt` } as any;
        const preview = truncate(stdoutText, 500);
        await command.editReply({ content: `Output attached as file:\n\n${preview}\n\n*(Full output attached)*`, files: [file] } as any);
      }

      return true;
    } catch (err) {
      if (err instanceof CliRunnerError) {
        await command.editReply("⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.");
      } else {
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
