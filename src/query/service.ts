import type { StoredLink } from "../db/repository.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface SearchableLinkStore {
  searchSimilarLinks(embedding: number[], limit: number): Promise<StoredLink[]>;
}

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

    const embedding = await this.embeddingProvider.embed(query);
    const results = await this.store.searchSimilarLinks(embedding, 3);

    if (!results.length) {
      return "I could not find any previously shared links for that query yet.";
    }

    const lines = ["Here are the most relevant links I found:"];
    for (const [index, result] of results.entries()) {
      const title = result.title ?? result.url;
      const summary = result.summary?.trim() || "No summary available.";
      lines.push(`${index + 1}. ${title}`);
      lines.push(`   ${result.url}`);
      lines.push(`   ${summary}`);
    }

    return lines.join("\n");
  }
}
