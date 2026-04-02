import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddProgressEvent, AddResult, RunnerOptions } from "../src/bot/cli-runner.js";

function createAddGenerator(
  events: AddProgressEvent[],
  result: AddResult
): AsyncGenerator<AddProgressEvent, AddResult, unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
    return result;
  })();
}

function createFakeMessage(
  content: string,
  overrides: { channelId?: string; messageId?: string; authorId?: string } = {}
) {
  const replies: string[] = [];
  const threadMessages: string[] = [];

  const thread = {
    id: "thread-1",
    send: vi.fn(async (text: string) => {
      threadMessages.push(String(text));
    }),
    setArchived: vi.fn(async (_archived: boolean) => undefined),
  };

  const message: any = {
    content,
    author: { id: overrides.authorId ?? "author-1" },
    id: overrides.messageId ?? "message-1",
    channelId: overrides.channelId ?? "channel-1",
    client: { user: { id: "bot-user-1" } },
    react: vi.fn(async (_emoji: string) => undefined),
    reply: vi.fn(async (text: string) => {
      replies.push(String(text));
    }),
    startThread: vi.fn(async (_opts: { name: string; autoArchiveDuration: number }) => thread),
    reactions: { cache: new Map<string, { users: { remove: (id: string) => Promise<void> } }>() },
  };

  return { message, replies, thread, threadMessages };
}

async function loadMonitoredMessageHandler(
  setupAdditionalMocks?: () => Promise<void>
): Promise<(message: any) => Promise<void>> {
  let capturedOptions: { onMonitoredMessage?: (message: any) => Promise<void> } | null = null;

  await vi.doMock("../src/discord/client.js", async () => {
    class MockDiscordBot {
      constructor(options: any) {
        capturedOptions = options;
      }

      async start(): Promise<void> {
        return;
      }
    }

    return { DiscordBot: MockDiscordBot };
  });

  const processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);

  try {
    if (setupAdditionalMocks) {
      await setupAdditionalMocks();
    }

    await import("../src/index.js");
  } finally {
    processOnSpy.mockRestore();
  }

  if (!capturedOptions) {
    throw new Error("Failed to capture onMonitoredMessage handler");
  }

  const handler = (capturedOptions as any).onMonitoredMessage;
  if (typeof handler !== "function") {
    throw new Error("Failed to capture onMonitoredMessage handler");
  }

  return handler as (message: any) => Promise<void>;
}

describe("index message handler integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.OB_CLI_PATH;
  });

  it("extracts a single URL and runs add once", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator([], {
        success: true,
        url,
        title: "Single URL",
      })
    );

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(async (url: string) => ({
            success: true,
            url,
            summary: "Mock summary",
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message } = createFakeMessage("Please index this: https://one.example/path");
    await onMonitoredMessage(message);

    expect(runAddCommandMock).toHaveBeenCalledTimes(1);
    expect(runAddCommandMock.mock.calls[0][0]).toBe("https://one.example/path");
  });

  it("extracts multiple URLs and ignores duplicate URLs", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator([], {
        success: true,
        url,
        title: "Indexed",
      })
    );

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(async (url: string) => ({
            success: true,
            url,
            summary: "Mock summary",
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message } = createFakeMessage(
      "https://one.example/a and https://two.example/b and again https://one.example/a"
    );

    await onMonitoredMessage(message);

    expect(runAddCommandMock).toHaveBeenCalledTimes(2);
    const urls = runAddCommandMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(["https://one.example/a", "https://two.example/b"]);
  });

  it("does nothing when no URL is present", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator([], {
        success: true,
        url,
        title: "unused",
      })
    );

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(async (url: string) => ({
            success: true,
            url,
            summary: "Mock summary",
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message, replies } = createFakeMessage("great work team, let's ship this");
    await onMonitoredMessage(message);

    expect(runAddCommandMock).not.toHaveBeenCalled();
    expect(message.startThread).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("calls runAddCommand with URL and message context", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator([], {
        success: true,
        url,
        title: "Context Check",
      })
    );

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(async (url: string) => ({
            success: true,
            url,
            summary: "Mock summary",
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message } = createFakeMessage("https://context.example/entry", {
      channelId: "channel-abc",
      messageId: "message-def",
      authorId: "author-ghi",
    });

    await onMonitoredMessage(message);

    expect(runAddCommandMock).toHaveBeenCalledWith("https://context.example/entry", {
      channelId: "channel-abc",
      messageId: "message-def",
      authorId: "author-ghi",
    });
  });

  it("creates a thread and posts progress updates with backtick wrapping", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator(
        [
          { phase: "downloading", url },
          { phase: "completed", url, title: "Useful Title" },
        ],
        {
          success: true,
          url,
          title: "Useful Title",
        }
      )
    );

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(async (url: string) => ({
            success: true,
            url,
            summary: "Mock summary",
          })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message, thread, threadMessages } = createFakeMessage("https://example.com/article");
    await onMonitoredMessage(message);

    expect(message.startThread).toHaveBeenCalledWith({
      name: "Processing: example.com",
      autoArchiveDuration: 60,
    });
    expect(thread.send).toHaveBeenCalled();
    expect(threadMessages).toContain("✅ Added to OpenBrain: `Useful Title`");
    expect(threadMessages).toContain("✅ Added: `Useful Title`");
  });

  it("passes Discord context tags to spawn for ob add", async () => {
    const spawnCalls: Array<{ exe: string; args: string[]; opts: unknown }> = [];

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      vi.doUnmock("../src/bot/cli-runner.js");

      const helper = await import("./helpers/mockCliSpawn.js");
      const { mockSpawn: versionSpawn } = helper.createSpawnMockVersion();
      const { mockSpawn: ndjsonSpawn } = helper.createSpawnMockNdjson([
        { phase: "completed", url: "https://ctx.example/item", title: "Ctx Title" },
      ]);
      const compositeSpawn = (exe: string, args: string[], opts: unknown) => {
        spawnCalls.push({ exe, args, opts });
        if (args && args[0] === "--version") {
          return versionSpawn(exe, args, opts);
        }
        return ndjsonSpawn(exe, args, opts);
      };
      await helper.doMockChildProcess(vi, compositeSpawn);
    });

    const { message } = createFakeMessage("https://ctx.example/item", {
      channelId: "channel-xyz",
      messageId: "message-xyz",
      authorId: "author-xyz",
    });

    await onMonitoredMessage(message);

    const addCall = spawnCalls.find((call) => call.args[0] === "add");
    expect(addCall).toBeDefined();

    const addArgs = addCall!.args;
    const tagValues: string[] = [];
    for (let i = 0; i < addArgs.length - 1; i++) {
      if (addArgs[i] === "--tag") {
        tagValues.push(addArgs[i + 1]);
      }
    }

    expect(tagValues).toContain("discord_channel_id:channel-xyz");
    expect(tagValues).toContain("discord_message_id:message-xyz");
    expect(tagValues).toContain("discord_author_id:author-xyz");
    expect(addArgs).toContain("https://ctx.example/item");
  });

  it("posts generated summary to the processing thread after successful add", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator(
        [
          { phase: "downloading", url },
          {
            phase: "completed",
            url,
            title: "Useful Title",
            id: 55,
            timestamp: "2026-04-02T15:00:00.000Z",
          },
        ],
        {
          success: true,
          url,
          title: "Useful Title",
          id: 55,
          timestamp: "2026-04-02T15:00:00.000Z",
        }
      )
    );

    const runSummaryCommandMock = vi.fn(async (url: string) => ({
      success: true,
      url,
      summary: "A concise generated summary.",
    }));

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: runSummaryCommandMock,
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message, thread, threadMessages } = createFakeMessage("https://example.com/article");
    await onMonitoredMessage(message);

    expect(runSummaryCommandMock).toHaveBeenCalledWith("https://example.com/article", {
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "author-1",
    });

    const summaryMessage = threadMessages.find((m) => m.includes("🧾 OpenBrain summary"));
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage).toContain("A concise generated summary.");
    expect(summaryMessage).toContain("OpenBrain item: <https://example.com/article>");
    expect(summaryMessage).toContain("Source URL: <https://example.com/article>");
    expect(summaryMessage).toContain("Item ID: 55");
    expect(summaryMessage).toContain("Author: <@author-1>");
    expect(summaryMessage).toContain("Timestamp: 2026-04-02T15:00:00.000Z");
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it("retries summary generation three times then marks for manual review", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator(
        [
          { phase: "downloading", url },
          { phase: "completed", url, title: "Useful Title", id: 91 },
        ],
        {
          success: true,
          url,
          title: "Useful Title",
          id: 91,
        }
      )
    );

    const runSummaryCommandMock = vi.fn(async (url: string) => ({
      success: false,
      url,
      error: "summary command failed",
    }));

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: runSummaryCommandMock,
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message, threadMessages } = createFakeMessage("https://example.com/article");
    await onMonitoredMessage(message);

    expect(runSummaryCommandMock).toHaveBeenCalledTimes(3);
    const manualReviewMessage = threadMessages.find((m) =>
      m.includes("Failed to generate summary for <https://example.com/article> after 3 attempts")
    );
    expect(manualReviewMessage).toBeDefined();
  });

  it("does not post duplicate summaries for the same item", async () => {
    const runAddCommandMock = vi.fn((url: string, _options?: RunnerOptions) =>
      createAddGenerator(
        [
          { phase: "downloading", url },
          { phase: "completed", url, title: "Useful Title", id: 777 },
        ],
        {
          success: true,
          url,
          title: "Useful Title",
          id: 777,
        }
      )
    );

    const runSummaryCommandMock = vi.fn(async (url: string) => ({
      success: true,
      url,
      summary: "Summary once",
    }));

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {
          exitCode: number;
          stderr: string;

          constructor(message: string, exitCode = -1, stderr = "") {
            super(message);
            this.name = "CliRunnerError";
            this.exitCode = exitCode;
            this.stderr = stderr;
          }
        }

        return {
          runAddCommand: runAddCommandMock,
          runQueueCommand: vi.fn(),
          runSummaryCommand: runSummaryCommandMock,
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const first = createFakeMessage("https://duplicate.example/path", {
      messageId: "m-1",
    });
    const second = createFakeMessage("https://duplicate.example/path", {
      messageId: "m-2",
    });

    await onMonitoredMessage(first.message);
    await onMonitoredMessage(second.message);

    expect(runSummaryCommandMock).toHaveBeenCalledTimes(1);

    const firstSummary = first.threadMessages.find((m) => m.includes("🧾 OpenBrain summary"));
    const secondSummary = second.threadMessages.find((m) => m.includes("🧾 OpenBrain summary"));
    expect(firstSummary).toBeDefined();
    expect(secondSummary).toBeUndefined();
  });
});
