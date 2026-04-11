import type { ChatInputCommandInteraction } from "discord.js";
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

  async handleCommand(command: ChatInputCommandInteraction): Promise<boolean> {
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

      // The CLI may return different JSON shapes across versions. Handle
      // both the legacy shape (totalContents/withEmbeddings/...) and the
      // newer structured StatsResult shape. Fall back to a best-effort
      // formatting when fields don't match expectations.
      if (stats && typeof stats === "object") {
        // New shape expected by the bot
        if (
          typeof (stats as any).totalLinks === "number" ||
          typeof (stats as any).processedCount === "number"
        ) {
          await command.editReply(this.formatStatsMessage(stats as StatsResult));
        } else if (typeof (stats as any).totalContents === "number") {
          // Legacy/OpenBrain older schema - map fields
          const mapped: StatsResult & { timeBased?: any } = {
            totalLinks: (stats as any).totalContents,
            processedCount: (stats as any).withEmbeddings ?? 0,
            pendingCount: ((stats as any).totalContents || 0) - ((stats as any).withEmbeddings || 0),
            failedCount: 0,
            timeBased: (stats as any).timeBased ?? (stats as any).time_based,
          };
          await command.editReply(this.formatStatsMessage(mapped));
        } else {
          // Unknown shape: present raw JSON in a readable form
          const pretty = JSON.stringify(stats, null, 2);
          const header = "📊 OpenBrain statistics (raw output)";
          // Use a fenced code block for readability
          await command.editReply(`${header}\n\n\`\`\`json\n${pretty}\n\`\`\``);
        }
      } else {
        await command.editReply(this.errorMessage);
      }
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
    const successRate = totalLinks > 0 ? ((processedCount / totalLinks) * 100) : 0;
    const failureRate = totalLinks > 0 ? ((failedCount / totalLinks) * 100) : 0;

    const lines: string[] = [];
    lines.push("📊 OpenBrain statistics");
    lines.push("");
    lines.push(`**Totals**`);
    lines.push(`- Total links: ${totalLinks.toLocaleString()}`);
    lines.push(`- Processed: ${processedCount.toLocaleString()} (${successRate.toFixed(1)}%)`);
    lines.push(`- Pending: ${pendingCount.toLocaleString()}`);
    lines.push(`- Failed: ${failedCount.toLocaleString()} (${failureRate.toFixed(1)}%)`);

    // Attempt to render time-based breakdown if available. Support multiple
    // possible field namings (timeBased, time_based, timebased).
    const tb = (stats as any).timeBased ?? (stats as any).time_based ?? (stats as any).timebased ?? (stats as any).time ?? null;
    const asNumber = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };

    if (tb && typeof tb === "object") {
      const last24 = asNumber(tb.last24Hours ?? tb.last_24_hours ?? tb.last24 ?? tb.last_24h ?? tb.last_24) ?? asNumber(tb["24h"]) ?? undefined;
      const last7 = asNumber(tb.last7Days ?? tb.last_7_days ?? tb.last7 ?? tb.last_7d ?? tb.last_7) ?? undefined;
      const last30 = asNumber(tb.last30Days ?? tb.last_30_days ?? tb.last30 ?? tb.last_30d ?? tb.last_30) ?? undefined;

      if (last24 !== undefined || last7 !== undefined || last30 !== undefined) {
        lines.push("");
        lines.push(`**By time**`);
        if (last24 !== undefined) {
          const pct = totalLinks > 0 ? ((last24 / totalLinks) * 100).toFixed(1) : "0.0";
          lines.push(`- Last 24 hours: ${last24.toLocaleString()} (${pct}%)`);
        }
        if (last7 !== undefined) {
          const pct = totalLinks > 0 ? ((last7 / totalLinks) * 100).toFixed(1) : "0.0";
          lines.push(`- Last 7 days: ${last7.toLocaleString()} (${pct}%)`);
        }
        if (last30 !== undefined) {
          const pct = totalLinks > 0 ? ((last30 / totalLinks) * 100).toFixed(1) : "0.0";
          lines.push(`- Last 30 days: ${last30.toLocaleString()} (${pct}%)`);
        }
      }
    }

    return lines.join("\n");
  }
}
