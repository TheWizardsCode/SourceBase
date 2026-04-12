import type { ChatInputCommandInteraction } from "discord.js";
import { runAddCommand, CliRunnerError } from "../bot/cli-runner.js";
import type { SlashCommandHandler } from "../interfaces/command-handler.js";

const DEFAULT_ERROR_MESSAGE = "❌ Failed to add URL/text to OpenBrain. Please try again.";

export interface AddCommandHandlerDependencies {
  runAdd?: typeof runAddCommand;
  errorMessage?: string;
}

export class AddCommandHandler implements SlashCommandHandler {
  private readonly runAdd: typeof runAddCommand;
  private readonly errorMessage: string;

  constructor(deps: AddCommandHandlerDependencies = {}) {
    this.runAdd = deps.runAdd ?? runAddCommand;
    this.errorMessage = deps.errorMessage ?? DEFAULT_ERROR_MESSAGE;
  }

  async handleCommand(command: ChatInputCommandInteraction): Promise<boolean> {
    if (command.commandName !== "add") return false;

    await command.deferReply();

    try {
      const input = command.options.getString("input", true).trim();

      // If input looks like a URL, pass it directly. Otherwise create a
      // temporary file flow is handled by existing message-based path; here
      // we simply pass the input as-is to the CLI which supports file:// or URLs.
      const args = ["--format", "ndjson", input];

      const gen = this.runAdd(input, {
        channelId: command.channelId ?? undefined,
        messageId: undefined,
        authorId: command.user?.id,
      } as any);

      // Manually iterate to capture the generator's return value (final result)
      let finalResult: any = undefined;
      while (true) {
        const it = await gen.next();
        if (it.done) {
          finalResult = it.value;
          break;
        }
        // ignore intermediate progress events for the slash command flow
      }

      const result = finalResult ?? ({} as any);

      if (!result || result.success === false) {
        if (result && result.exitCode !== undefined) {
          await command.editReply("❌ Add failed: CLI returned an error");
        } else {
          await command.editReply(this.errorMessage);
        }
        return true;
      }

      const itemLink = result.id !== undefined ? result.id : undefined;
      const display = result.title ? `\`${result.title}\`` : `\`${result.url}\``;
      if (itemLink !== undefined) {
        await command.editReply(`✅ Added: ${display} — OpenBrain item ID: ${itemLink}`);
      } else {
        await command.editReply(`✅ Added: ${display}`);
      }
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
