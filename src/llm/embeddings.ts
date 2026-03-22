import type { OpenAiCompatibleLlmClient } from "./client.js";

export class OpenAiCompatibleEmbeddingProvider {
  constructor(private readonly client: Pick<OpenAiCompatibleLlmClient, "embed">) {}

  async embed(text: string): Promise<number[]> {
    return this.client.embed(text);
  }
}
