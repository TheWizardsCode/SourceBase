import { setTimeout as delay } from "node:timers/promises";
import { cliConfig as config } from "../config/cli.js";

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

interface ChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export interface LlmClientOptions {
  baseUrl: string;
  model: string;
  maxRetries: number;
  retryDelayMs: number;
  // Optional separate model to use for embeddings (some proxies expose a dedicated embed model)
  embeddingModel?: string;
  // Optional embedding batch size override
  embeddingBatchSize?: number;
}

export class OpenAiCompatibleLlmClient {
  private readonly options: LlmClientOptions;

  constructor(options: LlmClientOptions) {
    this.options = options;
  }

  async embed(input: string): Promise<number[]> {
    const results = await this.embedBatch([input]);
    return results[0];
  }

  async embedBatch(inputs: string[]): Promise<number[][]> {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const model = this.options.embeddingModel ?? this.options.model;
    // Determine batch size: explicit option -> config -> default 2048
    const batchSize = this.options.embeddingBatchSize ?? config.LLM_EMBEDDING_BATCH_SIZE ?? 2048;

    const allEmbeddings: number[][] = [];
    for (let i = 0; i < inputs.length; i += batchSize) {
      const slice = inputs.slice(i, i + batchSize);
      const response = await this.requestWithRetry<EmbeddingResponse>("/embeddings", {
        model,
        input: slice,
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error("Embedding response missing data array");
      }

      // Ensure embeddings present for each input
      for (let j = 0; j < response.data.length; j++) {
        const item = response.data[j];
        if (!item || !Array.isArray(item.embedding)) {
          throw new Error("Embedding response missing embedding vector for one or more inputs");
        }
        allEmbeddings.push(item.embedding);
      }
    }

    return allEmbeddings;
  }

  async summarize(content: string, sessionId?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.options.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You summarize web pages for a Discord link archive. Provide a concise 2-3 sentence summary focused on key takeaways."
        },
        {
          role: "user",
          content
        }
      ]
    };

    // Add session_id for llama.cpp server context isolation
    if (sessionId) {
      payload.session_id = sessionId;
    }

    const response = await this.requestWithRetry<ChatResponse>("/chat/completions", payload);

    const summary = response.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      throw new Error("Summary response missing content");
    }

    return summary;
  }

  private async requestWithRetry<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.options.maxRetries) {
      try {
        const response = await fetch(`${this.options.baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(`LLM request failed with status ${response.status}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === this.options.maxRetries) {
          break;
        }

        await delay(this.options.retryDelayMs * Math.max(1, attempt + 1));
        attempt += 1;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`LLM request failed after retries: ${message}`);
  }
}
