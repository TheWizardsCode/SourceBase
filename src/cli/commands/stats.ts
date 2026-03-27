import { getDbPool } from "../../db/client.js";
import { LinkRepository, type DatabaseStats } from "../../db/repository.js";

interface StatsOptions {
  format?: "table" | "json";
  raw?: boolean;
}

function parseStatsArgs(args: string[]): { options: StatsOptions; error?: string } {
  const options: StatsOptions = {
    format: "table"
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--format" || arg === "-f") {
      const nextArg = args[++i];
      if (!nextArg || nextArg.startsWith("-")) {
        return { options, error: "Error: --format requires a value" };
      }
      if (!["table", "json"].includes(nextArg)) {
        return { options, error: `Error: Invalid format "${nextArg}". Valid options: table, json` };
      }
      options.format = nextArg as "table" | "json";
    } else if (arg === "--raw" || arg === "-r") {
      options.raw = true;
    } else {
      return { options, error: `Error: Unknown option "${arg}"` };
    }
  }
  
  return { options };
}

function formatTable(stats: DatabaseStats): string {
  const lines: string[] = [];
  
  // Header
  lines.push("┌" + "─".repeat(40) + "┬" + "─".repeat(15) + "┐");
  lines.push("│ Metric" + " ".repeat(33) + "│ Count" + " ".repeat(9) + "│");
  lines.push("├" + "─".repeat(40) + "┼" + "─".repeat(15) + "┤");
  
  // Core metrics
  lines.push(`│ Total Links${" ".repeat(28)} │ ${String(stats.totalLinks).padStart(13)} │`);
  lines.push(`│ With Embeddings${" ".repeat(24)} │ ${String(stats.linksWithEmbeddings).padStart(13)} │`);
  lines.push(`│ With Summaries${" ".repeat(25)} │ ${String(stats.linksWithSummaries).padStart(13)} │`);
  lines.push(`│ With Content${" ".repeat(27)} │ ${String(stats.linksWithContent).padStart(13)} │`);
  lines.push(`│ With Transcripts${" ".repeat(23)} │ ${String(stats.linksWithTranscripts).padStart(13)} │`);
  
  // Separator
  lines.push("├" + "─".repeat(40) + "┼" + "─".repeat(15) + "┤");
  
  // Time-based metrics
  lines.push(`│ Last 24 Hours${" ".repeat(26)} │ ${String(stats.linksLast24Hours).padStart(13)} │`);
  lines.push(`│ Last 7 Days${" ".repeat(28)} │ ${String(stats.linksLast7Days).padStart(13)} │`);
  lines.push(`│ Last 30 Days${" ".repeat(27)} │ ${String(stats.linksLast30Days).padStart(13)} │`);
  
  // Footer
  lines.push("└" + "─".repeat(40) + "┴" + "─".repeat(15) + "┘");
  
  return lines.join("\n");
}

function formatJson(stats: DatabaseStats): string {
  return JSON.stringify({
    totalLinks: stats.totalLinks,
    withEmbeddings: stats.linksWithEmbeddings,
    withSummaries: stats.linksWithSummaries,
    withContent: stats.linksWithContent,
    withTranscripts: stats.linksWithTranscripts,
    timeBased: {
      last24Hours: stats.linksLast24Hours,
      last7Days: stats.linksLast7Days,
      last30Days: stats.linksLast30Days
    }
  }, null, 2);
}

function formatRaw(stats: DatabaseStats): string {
  // Output raw numbers for scripting, one per line with labels
  return [
    `total:${stats.totalLinks}`,
    `embeddings:${stats.linksWithEmbeddings}`,
    `summaries:${stats.linksWithSummaries}`,
    `content:${stats.linksWithContent}`,
    `transcripts:${stats.linksWithTranscripts}`,
    `last24h:${stats.linksLast24Hours}`,
    `last7d:${stats.linksLast7Days}`,
    `last30d:${stats.linksLast30Days}`
  ].join("\n");
}

export async function statsCommand(args: string[]): Promise<{ stats: DatabaseStats | null; exitCode: number }> {
  const { options, error } = parseStatsArgs(args);
  
  if (error) {
    console.error(error);
    return { stats: null, exitCode: 2 };
  }
  
  try {
    // Get database connection and stats
    const pool = getDbPool();
    const repository = new LinkRepository(pool);
    
    const stats = await repository.getStats();
    
    // Format output
    let output: string;
    if (options.raw) {
      output = formatRaw(stats);
    } else if (options.format === "json") {
      output = formatJson(stats);
    } else {
      output = formatTable(stats);
    }
    
    console.log(output);
    
    return { stats, exitCode: 0 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: Unable to connect to database: ${errorMessage}`);
    return { stats: null, exitCode: 1 };
  }
}
