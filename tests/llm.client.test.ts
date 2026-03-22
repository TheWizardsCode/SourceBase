import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleLlmClient } from "../src/llm/client.js";

describe("OpenAiCompatibleLlmClient", () => {
  it("returns embedding vectors from proxy response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
      })
    );

    const client = new OpenAiCompatibleLlmClient({
      baseUrl: "http://llm.local/v1",
      model: "test-model",
      maxRetries: 0,
      retryDelayMs: 0
    });

    await expect(client.embed("abc")).resolves.toEqual([0.1, 0.2]);
  });

  it("retries on failures and eventually returns summary", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Short summary" } }] })
      });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAiCompatibleLlmClient({
      baseUrl: "http://llm.local/v1",
      model: "test-model",
      maxRetries: 1,
      retryDelayMs: 0
    });

    await expect(client.summarize("body text")).resolves.toBe("Short summary");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
