import type { StoredLink } from "../db/repository.js";
import { config } from "../config.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface SearchableLinkStore {
  searchSimilarLinks(embedding: number[], limit: number): Promise<StoredLink[]>;
}

const TARGET_EMBED_DIM = config.LLM_EMBEDDING_DIM;

export class QueryService {
  constructor(
    private readonly store: SearchableLinkStore,
    private readonly embeddingProvider: EmbeddingProvider
  ) {}

  async answerQuery(messageContent: string): Promise<string | null> {
    const query = messageContent.trim();
    if (!query) {
      return null;
    }

    let embedding = await this.embeddingProvider.embed(query);

    const results = await this.store.searchSimilarLinks(embedding, 3);

    if (!results.length) {
      return "I could not find any previously shared links for that query yet.";
    }

    const lines = ["Here are the most relevant links I found:"];
    const MAX_TOTAL_LENGTH = 2000;
    const HEADER_LENGTH = lines[0].length + 2; // +2 for newlines
    
    // Calculate available space per result (rough estimate)
    const maxPerResult = Math.floor((MAX_TOTAL_LENGTH - HEADER_LENGTH) / results.length);
    
    for (const [index, result] of results.entries()) {
      const title = result.title ?? result.url;
      let summary = result.summary?.trim() || "No summary available.";
      
      // Truncate summary if needed to fit within Discord's limit
      // Reserve space for formatting (number, title, url, newlines)
      const reservedSpace = 50; // Approximate space for formatting
      const maxSummaryLength = Math.max(50, maxPerResult - reservedSpace - title.length);
      
      if (summary.length > maxSummaryLength) {
        summary = summary.slice(0, maxSummaryLength - 3) + "...";
      }
      
      lines.push(`**${index + 1}. ${title}**`);
      lines.push(`<${result.url}>`);
      lines.push("");
      lines.push(`> ${summary}`);
    }

    let result = lines.join("\n");
    
    // Final safety check - truncate if still too long
    if (result.length > MAX_TOTAL_LENGTH) {
      result = result.slice(0, MAX_TOTAL_LENGTH - 3) + "...";
    }
    
    return result;
  }
}
