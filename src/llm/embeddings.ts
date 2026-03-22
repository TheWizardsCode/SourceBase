import { config } from "../config.js";

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export class OpenAiCompatibleEmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${config.LLM_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.LLM_MODEL,
        input: text
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`);
    }

    const json = (await response.json()) as EmbeddingResponse;
    if (!json.data?.length || !Array.isArray(json.data[0].embedding)) {
      throw new Error("Embedding response missing embedding vector");
    }

    return json.data[0].embedding;
  }
}
