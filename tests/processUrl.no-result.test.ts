import { vi, describe, it, beforeEach, expect } from "vitest";

// Minimal test harness: we will mock the cli-runner to provide a
// runAddCommand async-generator that completes without returning a value.

vi.doMock("../src/bot/cli-runner.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  // Provide a runAddCommand that yields nothing and returns undefined
  async function* runAddCommand(_url: string) {
    return undefined as any;
  }

  return { ...actual, runAddCommand };
});

// Import runtime JS build for ESM resolution in test environment
import { processUrlWithProgress } from "../src/index.js";

describe("processUrlWithProgress defensive handling", () => {
  let message: any;

  beforeEach(() => {
    message = {
      id: "m1",
      channelId: "c1",
      author: { id: "u1" },
      reply: vi.fn().mockResolvedValue(undefined),
      react: vi.fn().mockResolvedValue(undefined),
      client: { user: { id: "bot" } },
      reactions: { cache: new Map() },
    } as any;
  });

  it("does not throw when runAddCommand returns no result and replies with an error", async () => {
    await expect(processUrlWithProgress(message, "file:///tmp/doesnotexist")).resolves.not.toThrow();
    expect(message.reply).toHaveBeenCalled();
  });
});
