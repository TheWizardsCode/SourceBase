import { setTimeout as delay } from "node:timers/promises";

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
}

export class OpenAiCompatibleLlmClient {
  private readonly options: LlmClientOptions;

  constructor(options: LlmClientOptions) {
    this.options = options;
  }

  async embed(input: string): Promise<number[]> {
    const response = await this.requestWithRetry<EmbeddingResponse>("/embeddings", {
      model: this.options.model,
      input
    });

    if (!response.data?.length || !Array.isArray(response.data[0].embedding)) {
      throw new Error("Embedding response missing embedding vector");
    }

    return response.data[0].embedding;
  }

  async summarize(content: string): Promise<string> {
    const response = await this.requestWithRetry<ChatResponse>("/chat/completions", {
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
    });

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
