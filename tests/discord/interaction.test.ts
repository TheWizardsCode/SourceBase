import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAddGenerator } from "../helpers/createAddGenerator.js";

async function loadInteractionHandler(setupAdditionalMocks?: () => Promise<void>) {
  let lastOpts: any = null;

  await vi.doMock("../../src/discord/client.js", async () => {
    let captured: any = null;
    class MockDiscordBot {
      constructor(opts: any) {
        captured = opts;
      }

      async start() {
        // no-op to avoid network
        return;
      }
    }

    return {
      DiscordBot: MockDiscordBot,
      __getLastOpts: () => captured,
    };
  });

  try {
    if (setupAdditionalMocks) {
      await setupAdditionalMocks();
    }

    // Import module under test (this will instantiate the mocked DiscordBot)
    await import("../../src/index.js");
  } finally {
    // nothing
  }

  const discordModule = await import("../../src/discord/client.js");
  const captured = (discordModule as any).__getLastOpts();
  if (!captured) throw new Error("Failed to capture DiscordBot options");
  const handler = captured.onInteraction;
  if (typeof handler !== "function") throw new Error("onInteraction handler not found");
  return handler as (interaction: any) => Promise<void>;
}

describe("slash interaction handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("parses JSON array search output into [title](url) lines", async () => {
    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: vi.fn(async (cmd: string) => {
            if (cmd === "search") {
              return {
                exitCode: 0,
                stdout: [
                  JSON.stringify([
                    { title: "Alpha", url: "http://a.example" },
                    { title: "Beta", url: "http://b.example" },
                  ]),
                ],
              };
            }
            return { exitCode: 0, stdout: [] };
          }),
          // provide a minimal async-generator shaped stub so consumers iterating it
          // always get a final return value and don't encounter undefined finalResult
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "search",
      options: { getString: (_: string, __: boolean) => "query", getInteger: (_: string) => 2 },
      user: { id: "user-1" },
      channelId: "chan-1",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-1" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(edits.length).toBeGreaterThan(0);
    const body = edits[0];
    expect(body).toContain("[Alpha](http://a.example)");
    expect(body).toContain("[Beta](http://b.example)");
  });

  it("routes /stats through StatsCommandHandler", async () => {
    const runStatsCommandMock = vi.fn(async () => ({
      raw: [
        "📊 OpenBrain statistics",
        "",
        "**Totals**",
        "- Total links: 100",
        "- Processed: 80 (80.0%)",
        "- Pending: 15",
        "- Failed: 5 (5.0%)",
      ].join("\n"),
    }));

    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: vi.fn(async () => ({ exitCode: 0, stdout: [] })),
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: runStatsCommandMock,
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "stats",
      options: { getString: vi.fn(), getInteger: vi.fn() },
      user: { id: "user-1" },
      channelId: "chan-1",
      deferReply: vi.fn(async () => {}),
      id: "interaction-1",
      editReply: vi.fn(async (content: string) => edits.push(content)),
      fetchReply: vi.fn(async () => ({ id: "posted-1" })),
      reply: vi.fn(async (_content: string) => {}),
    };

    await handler(fakeInteraction);

    expect(fakeInteraction.deferReply).toHaveBeenCalledTimes(1);
    expect(runStatsCommandMock).toHaveBeenCalledWith({
      channelId: "chan-1",
      messageId: "interaction-1",
      authorId: "user-1",
    });
    expect(edits).toContain(
      "```markdown\n" +
      [
        "📊 OpenBrain statistics",
        "",
        "**Totals**",
        "- Total links: 100",
        "- Processed: 80 (80.0%)",
        "- Pending: 15",
        "- Failed: 5 (5.0%)",
      ].join("\n") +
      "\n```"
    );
  });

  it("falls back to line parsing when search output is not JSON", async () => {
    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: vi.fn(async (cmd: string) => {
            if (cmd === "search") {
              return {
                exitCode: 0,
                stdout: [
                  "1 | The First Article | http://first.example | 0.92",
                  "2 | Second Thing | http://second.example | 0.88",
                ],
              };
            }
            return { exitCode: 0, stdout: [] };
          }),
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "search",
      options: { getString: (_: string, __: boolean) => "q", getInteger: (_: string) => 2 },
      user: { id: "u" },
      channelId: "ch",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-2" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(edits.length).toBeGreaterThan(0);
    const body = edits[0];
    expect(body).toContain("[The First Article](http://first.example)");
    expect(body).toContain("[Second Thing](http://second.example)");
  });

  it("handles briefing output that is not JSON by returning raw text", async () => {
    const runCliCommandMock = vi.fn(async (cmd: string) => {
      if (cmd === "briefing") {
        return {
          exitCode: 0,
          stdout: [
            "---",
            "## Summary",
            "This is a short briefing summary.",
            "## Sources",
            "1. http://source.example",
          ],
        };
      }
      return { exitCode: 0, stdout: [] };
    });

    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: runCliCommandMock,
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "briefing",
      options: {
        getString: (_: string, __: boolean) => "indie games",
        getInteger: (_: string) => null,
      },
      user: { id: "user-x" },
      channelId: "chan-x",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-3" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(edits.length).toBeGreaterThan(0);
    const body = edits[0];
    expect(body).toContain("## Summary");
    expect(body).toContain("This is a short briefing summary.");
    expect(runCliCommandMock).toHaveBeenCalledWith(
      "briefing",
      ["run", "--json", "--query", "indie games"],
      expect.any(Object)
    );
  });

  it("parses JSON array recent output into id/title/modified lines", async () => {
    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: vi.fn(async (cmd: string) => {
            if (cmd === "recent") {
              return {
                exitCode: 0,
                stdout: [
                  JSON.stringify([
                    { id: 1, title: "Alpha", modified: "2026-04-07T12:00:00Z", summary: "One-liner alpha" },
                    { id: 2, title: "Beta", modified: "2026-04-07T13:00:00Z", summary: "One-liner beta" },
                  ]),
                ],
              };
            }
            return { exitCode: 0, stdout: [] };
          }),
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "recent",
      options: { getInteger: (_: string) => null },
      user: { id: "user-1" },
      channelId: "chan-1",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-1" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(edits.length).toBeGreaterThan(0);
    const body = edits[0];
    expect(body).toContain("Alpha");
    expect(body).toContain("Beta");
    expect(body).toContain("2026-04-07T12:00:00");
  });

  it("rejects out-of-range recent limit before calling CLI", async () => {
    const runCliCommandMock = vi.fn(async () => ({ exitCode: 0, stdout: ["[]"] }));

    const handler = await loadInteractionHandler(async () => {
    await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: runCliCommandMock,
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "recent",
      options: { getInteger: (_: string) => 999 },
      user: { id: "user-1" },
      channelId: "chan-1",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-1" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(runCliCommandMock).not.toHaveBeenCalled();
    expect(edits).toContain("⚠️ Recent parameter `limit` must be between 1 and 100.");
  });

  it("passes optional briefing k argument through to CLI when provided", async () => {
    const runCliCommandMock = vi.fn(async (cmd: string) => {
      if (cmd === "briefing") {
        return {
          exitCode: 0,
          stdout: ["Briefing output"],
        };
      }
      return { exitCode: 0, stdout: [] };
    });

    const handler = await loadInteractionHandler(async () => {
      await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: runCliCommandMock,
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "briefing",
      options: {
        getString: (_: string, __: boolean) => "ai safety",
        getInteger: (_: string) => 7,
      },
      user: { id: "user-k" },
      channelId: "chan-k",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (_content: string) => {}),
      fetchReply: vi.fn(async () => ({ id: "posted-k" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(runCliCommandMock).toHaveBeenCalledWith(
      "briefing",
      ["run", "--json", "--query", "ai safety", "--k", "7"],
      expect.any(Object)
    );
  });

  it("rejects out-of-range briefing k before calling CLI", async () => {
    const runCliCommandMock = vi.fn(async () => ({ exitCode: 0, stdout: ["unused"] }));

    const handler = await loadInteractionHandler(async () => {
      await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: runCliCommandMock,
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "briefing",
      options: {
        getString: (_: string, __: boolean) => "ai safety",
        getInteger: (_: string) => 999,
      },
      user: { id: "user-k" },
      channelId: "chan-k",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(content)),
      fetchReply: vi.fn(async () => ({ id: "posted-k" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(runCliCommandMock).not.toHaveBeenCalled();
    expect(edits).toContain("⚠️ Briefing parameter `k` must be between 1 and 50.");
  });

  it("wraps markdown briefing text at 80 characters on nearest spaces", async () => {
    const runCliCommandMock = vi.fn(async (cmd: string) => {
      if (cmd === "briefing") {
        return {
          exitCode: 0,
          stdout: [
            "This briefing paragraph is intentionally long so it should wrap at roughly eighty characters without splitting words in the middle.",
          ],
        };
      }
      return { exitCode: 0, stdout: [] };
    });

    const handler = await loadInteractionHandler(async () => {
      await vi.doMock("../../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runCliCommand: runCliCommandMock,
          runAddCommand: vi.fn(() => createAddGenerator([], { success: true, id: 1, url: "" } as any)),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({
            totalLinks: 0,
            processedCount: 0,
            pendingCount: 0,
            failedCount: 0,
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: class MockCliRunnerError extends Error {},
        };
      });
    });

    const edits: string[] = [];
    const fakeInteraction: any = {
      isCommand: () => true,
      commandName: "briefing",
      options: {
        getString: (_: string, __: boolean) => "line wrapping",
        getInteger: (_: string) => null,
      },
      user: { id: "user-wrap" },
      channelId: "chan-wrap",
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (content: string) => edits.push(String(content))),
      fetchReply: vi.fn(async () => ({ id: "posted-wrap" })),
      reply: vi.fn(async () => {}),
    };

    await handler(fakeInteraction);

    expect(edits.length).toBeGreaterThan(0);
    const body = edits[0];
    const contentLines = body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.startsWith("📝 Briefing for:"));

    expect(contentLines.length).toBeGreaterThan(1);
    expect(contentLines.every((line) => line.length <= 80)).toBe(true);
  });
});
