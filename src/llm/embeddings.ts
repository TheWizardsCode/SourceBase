import type { OpenAiCompatibleLlmClient } from "./client.js";
import { cliConfig as config } from "../config/cli.js";

const MAX_EMBED_CHARS = config.LLM_EMBEDDING_MAX_CHARS;

function chunkText(text: string, maxChars: number): string[] {
  if (!text || text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf(' ', maxChars);
    if (splitIdx === -1) splitIdx = maxChars;
    const part = remaining.slice(0, splitIdx).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitIdx).trim();
  }
  return chunks;
}

function averageVectors(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const len = vectors[0].length;
  const sum = new Array<number>(len).fill(0);
  for (const vec of vectors) {
    if (vec.length !== len) return null;
    for (let i = 0; i < len; i++) sum[i] += vec[i];
  }
  return sum.map(v => v / vectors.length);
}

export class OpenAiCompatibleEmbeddingProvider {
  constructor(private readonly client: Pick<OpenAiCompatibleLlmClient, "embed" | "embedBatch">) {}

  async embed(text: string): Promise<number[]> {
    const chunks = chunkText(text, MAX_EMBED_CHARS);
    const results: number[][] = [];
    for (const chunk of chunks) {
      const vectors = await this.client.embedBatch([chunk]);
      results.push(vectors[0]);
    }
    const averaged = averageVectors(results);
    if (!averaged) throw new Error("Embedding vectors have mismatched dimensions");
    return averaged;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return this.client.embedBatch(texts);
  }
}
