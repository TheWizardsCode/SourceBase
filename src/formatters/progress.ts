import type { AddProgressEvent } from "../bot/cli-runner.js";
import { truncate } from "../presenters/discordFormatting.js";

export function formatProgressMessage(event: AddProgressEvent): string {
  const phase = typeof event.phase === "string" && event.phase.trim() !== "" ? event.phase : undefined;

  if (!phase) {
    if (event.message) {
      const m = String(event.message).trim();
      const truncated = truncate(m, 1500);
      if (event.title) return `❌ ${truncated} (${event.title})`;
      if (event.url) return `❌ ${truncated} (<${event.url}>)`;
      return `❌ ${truncated}`;
    }

    const parts: string[] = [];
    if (event.id !== undefined) parts.push(`id:${event.id}`);
    if (event.title) parts.push(`title:${event.title}`);
    if (event.url) parts.push(`url:${event.url}`);
    if (event.timestamp) parts.push(`ts:${event.timestamp}`);

    if (parts.length > 0) {
      return `⏳ Processing: unknown (${parts.join(", ")})`;
    }

    return "⏳ Processing: unknown event";
  }

  switch (phase) {
    case "downloading":
      return "⏳ Downloading content...";
    case "extracting":
      return "📝 Extracting text content...";
    case "embedding":
      return "🧠 Generating embeddings...";
    case "completed":
      return `✅ Added to OpenBrain: ${event.title || "URL processed"}`;
    case "failed":
      return `❌ Failed: ${event.message || "Unknown error"}`;
    default:
      const base = `⏳ Processing: ${phase}`;
      if (event.message) {
        const m = String(event.message).trim();
        const truncated = truncate(m, 1200);
        return `${base}\n\n${truncated}`;
      }
      return base;
  }
}
