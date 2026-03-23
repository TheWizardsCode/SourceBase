import type { StoredLink } from "../db/repository.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface SearchableLinkStore {
  searchSimilarLinks(embedding: number[], limit: number): Promise<StoredLink[]>;
}

// Target embedding dimension must match the dimension used for stored embeddings
const TARGET_EMBED_DIM = 2000;

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
    
    // Resize query embedding to match stored embedding dimension
    if (embedding.length !== TARGET_EMBED_DIM) {
      if (embedding.length > TARGET_EMBED_DIM) {
        embedding = embedding.slice(0, TARGET_EMBED_DIM);
      } else {
        const padding = new Array(TARGET_EMBED_DIM - embedding.length).fill(0);
        embedding = embedding.concat(padding);
      }
    }
    
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
