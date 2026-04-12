import type { ChatInputCommandInteraction } from "discord.js";
import { runCliCommand, CliRunnerError } from "../bot/cli-runner.js";
import { DISCORD_CONTENT_LIMIT } from "../presenters/discordFormatting.js";
import type { SlashCommandHandler } from "../interfaces/command-handler.js";

const DEFAULT_ERROR_MESSAGE = "❌ Failed to retrieve recent OpenBrain items. Please try again.";

export interface RecentCommandHandlerDependencies {
  runCli?: typeof runCliCommand;
  errorMessage?: string;
}

export class RecentCommandHandler implements SlashCommandHandler {
  private readonly runCli: typeof runCliCommand;
  private readonly errorMessage: string;

  constructor(dependencies: RecentCommandHandlerDependencies = {}) {
    this.runCli = dependencies.runCli ?? runCliCommand;
    this.errorMessage = dependencies.errorMessage ?? DEFAULT_ERROR_MESSAGE;
  }

  async handleCommand(command: ChatInputCommandInteraction): Promise<boolean> {
    if (command.commandName !== "recent") return false;

    await command.deferReply();

    try {
      const opt = command.options.getInteger("limit");
      const limit = opt ?? 5;

      if (opt !== null && (limit < 1 || limit > 100)) {
        await command.editReply("⚠️ Recent parameter `limit` must be between 1 and 100.");
        return true;
      }

      const args = ["--json", "--limit", String(limit)];

      const result = await this.runCli("recent", args, {
        channelId: command.channelId ?? undefined,
        messageId: undefined,
        authorId: command.user?.id,
      });

      if (result.exitCode !== 0) {
        await command.editReply("❌ Recent failed: CLI returned an error");
        return true;
      }

      if (!result.stdout || result.stdout.length === 0) {
        await command.editReply("No recent items found.");
        return true;
      }

      const stdoutText = result.stdout.join("\n").trim();
      let items: any[] = [];

      try {
        const parsed = JSON.parse(stdoutText);
        if (Array.isArray(parsed)) {
          items = parsed.slice(0, limit);
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray((parsed as any).items)) items = (parsed as any).items.slice(0, limit);
          else if (Array.isArray((parsed as any).results)) items = (parsed as any).results.slice(0, limit);
          else if (Array.isArray((parsed as any).rows)) items = (parsed as any).rows.slice(0, limit);
          else {
            const arrProp = Object.keys(parsed).find((k) => Array.isArray((parsed as any)[k]));
            if (arrProp) items = (parsed as any)[arrProp].slice(0, limit);
            else items = [parsed];
          }
        }
      } catch {
        // Fallback: try parsing each stdout line as JSON (NDJSON style)
        for (const line of result.stdout) {
          try {
            const obj = JSON.parse(line);
            if (obj) items.push(obj);
          } catch {
            // ignore non-json lines
          }
        }
        items = items.slice(0, limit);
      }

      // Ensure we have an array of entries
      items = items.filter(Boolean);

      if (items.length === 0) {
        await command.editReply("No recent items found.");
        return true;
      }

      // Helper to escape stray closing bracket to avoid accidental markdown
      const escape = (s: unknown) => {
        if (s === undefined || s === null) return "";
        return String(s).replace(/\]/g, "\\]").replace(/\[/g, "\\[");
      };

      const lines: string[] = [];
      lines.push("🕘 Recent OpenBrain items");
      lines.push("");

      for (const it of items) {
        const id = it.id ?? it.item_id ?? it.itemId ?? it._id ?? "";
        const title = it.title ?? it.name ?? it.heading ?? it.text ?? "(untitled)";
        const modified = it.modified ?? it.updated_at ?? it.updated ?? it.timestamp ?? it.mtime ?? "";
        const summary = it.summary ?? it.brief ?? it.description ?? it.text ?? "";

        const idPart = id !== "" ? `\`${String(id)}\`` : "";
        const titlePart = escape(title);
        const modifiedPart = modified ? ` — ${String(modified)}` : "";

        lines.push(`- ${idPart} ${titlePart}${modifiedPart}`.trim());

        if (summary && typeof summary === "string") {
          const one = summary.replace(/\s+/g, " ").trim();
          const short = one.length > 200 ? one.slice(0, 197).trim() + "..." : one;
          if (short) lines.push(`  ${short}`);
        }

        lines.push("");
      }

      const message = lines.join("\n").trim();
      if (message.length <= DISCORD_CONTENT_LIMIT) {
        await command.editReply(message);
      } else {
        // Attach full content as a markdown file and post a short TOC
        const filename = `recent-${Date.now()}.md`;
        const summary = lines.slice(0, 20).join("\n");
        const file = { attachment: Buffer.from(lines.join("\n"), "utf8"), name: filename } as any;
        await command.editReply({ content: `${"🕘 Recent OpenBrain items"}\n\n${summary}\n\n*(Full content attached as ${filename})*`, files: [file] } as any);
      }
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.error("RecentCommandHandler: error while retrieving recent items:", err);
      } catch {
        // ignore logging issues
      }

      if (err instanceof CliRunnerError) {
        const CLI_UNAVAILABLE_MESSAGE =
          "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.";
        await command.editReply(CLI_UNAVAILABLE_MESSAGE);
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
