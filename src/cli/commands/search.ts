import { config } from "../../config.js";
import { getDbPool } from "../../db/client.js";
import { LinkRepository, type SearchResult } from "../../db/repository.js";
import { OpenAiCompatibleLlmClient } from "../../llm/client.js";

interface SearchOptions {
  verbose?: boolean;
  limit?: number;
  format?: "table" | "json" | "urls-only";
}

interface SearchResultItem {
  id: number;
  url: string;
  title: string | null;
  summary: string | null;
  similarity: number;
}

function parseSearchArgs(args: string[]): { query: string; options: SearchOptions; error?: string } {
  const options: SearchOptions = {
    limit: 5,
    format: "table"
  };
  
  const positionalArgs: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--limit" || arg === "-l") {
      const nextArg = args[++i];
      if (!nextArg || nextArg.startsWith("-")) {
        return { query: "", options, error: "Error: --limit requires a value" };
      }
      const limit = parseInt(nextArg, 10);
      if (isNaN(limit) || limit < 1 || limit > 20) {
        return { query: "", options, error: "Error: --limit must be between 1 and 20" };
      }
      options.limit = limit;
    } else if (arg === "--format" || arg === "-f") {
      const nextArg = args[++i];
      if (!nextArg || nextArg.startsWith("-")) {
        return { query: "", options, error: "Error: --format requires a value" };
      }
      if (!["table", "json", "urls-only"].includes(nextArg)) {
        return { query: "", options, error: `Error: Invalid format "${nextArg}". Valid options: table, json, urls-only` };
      }
      options.format = nextArg as "table" | "json" | "urls-only";
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    } else {
      return { query: "", options, error: `Error: Unknown option "${arg}"` };
    }
  }
  
  // Join positional args to form the query (handles queries with spaces when quoted)
  const query = positionalArgs.join(" ").trim();
  
  if (!query) {
    return { query: "", options, error: "Error: Search query is required\nUsage: sb search [options] <query>\n\nOptions:\n  --limit, -l N     Number of results (1-20, default: 5)\n  --format, -f      Output format: table, json, urls-only (default: table)\n  --verbose, -v     Enable verbose output" };
  }
  
  return { query, options };
}

function formatTable(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found";
  }
  
  const lines: string[] = [];
  lines.push("┌".padEnd(53, "─") + "┬" + "─".padEnd(53, "─") + "┬" + "──────────" + "┐");
  lines.push("│ Title" + " ".repeat(48) + "│ URL" + " ".repeat(50) + "│ Similarity │");
  lines.push("├".padEnd(53, "─") + "┼" + "─".padEnd(53, "─") + "┼" + "──────────" + "┤");
  
  for (const result of results) {
    const title = (result.title || "(no title)").substring(0, 50);
    const url = result.url.substring(0, 50);
    const similarity = `${Math.round(result.similarity * 100)}%`.padStart(8);
    
    lines.push(`│ ${title.padEnd(51)} │ ${url.padEnd(51)} │ ${similarity} │`);
  }
  
  lines.push("└".padEnd(53, "─") + "┴" + "─".padEnd(53, "─") + "┴" + "──────────" + "┘");
  
  return lines.join("\n");
}

function formatJson(results: SearchResult[]): string {
  const items: SearchResultItem[] = results.map(r => ({
    id: r.id,
    url: r.url,
    title: r.title,
    summary: r.summary,
    similarity: Math.round(r.similarity * 10000) / 10000 // Round to 4 decimal places
  }));
  
  return JSON.stringify(items, null, 2);
}

function formatUrlsOnly(results: SearchResult[]): string {
  if (results.length === 0) {
    return "";
  }
  
  return results.map(r => r.url).join("\n");
}

export async function searchCommand(args: string[]): Promise<{ results: SearchResult[]; exitCode: number }> {
  const { query, options, error } = parseSearchArgs(args);
  
  if (error) {
    console.error(error);
    return { results: [], exitCode: 2 };
  }
  
  if (options.verbose) {
    console.error(`Searching for: "${query}"`);
    console.error(`Limit: ${options.limit}`);
    console.error(`Format: ${options.format}`);
  }
  
  try {
    // Generate embedding for the query
    const llmClient = new OpenAiCompatibleLlmClient({
      baseUrl: config.LLM_BASE_URL,
      model: config.LLM_MODEL,
      maxRetries: config.LLM_MAX_RETRIES,
      retryDelayMs: config.LLM_RETRY_DELAY_MS
    });
    
    if (options.verbose) {
      console.error("Generating query embedding...");
    }
    
    const embedding = await llmClient.embed(query);
    
    if (options.verbose) {
      console.error(`Embedding generated (${embedding.length} dimensions)`);
    }
    
    // Search for similar links
    const pool = getDbPool();
    const repository = new LinkRepository(pool);
    
    if (options.verbose) {
      console.error(`Searching database for top ${options.limit} results...`);
    }
    
    const results = await repository.searchSimilarLinksWithScores(embedding, options.limit);
    
    if (options.verbose) {
      console.error(`Found ${results.length} results`);
    }
    
    // Format output
    let output: string;
    switch (options.format) {
      case "json":
        output = formatJson(results);
        break;
      case "urls-only":
        output = formatUrlsOnly(results);
        break;
      case "table":
      default:
        output = formatTable(results);
        break;
    }
    
    if (output) {
      console.log(output);
    }
    
    return { results, exitCode: 0 };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: Search failed - ${errorMessage}`);
    return { results: [], exitCode: 1 };
  }
}
