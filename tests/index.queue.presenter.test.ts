import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadMonitoredMessageHandler(setupAdditionalMocks?: () => Promise<void>) {
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

  const processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process as any);

  try {
    if (setupAdditionalMocks) await setupAdditionalMocks();
    await import("../src/index.js");
  } finally {
    processOnSpy.mockRestore();
  }

  if (!capturedOptions) throw new Error("Failed to capture onMonitoredMessage handler");
  const handler = (capturedOptions as any).onMonitoredMessage;
  if (typeof handler !== "function") throw new Error("Failed to capture onMonitoredMessage handler");
  return handler as (message: any) => Promise<void>;
}

describe("QueuePresenter lifecycle (crawl command)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.OB_CLI_PATH;
  });

  it("posts a status message, updates it on success, and clears it", async () => {
    const runQueueCommandMock = vi.fn(async (url: string, _opts?: any) => ({ success: true, url, id: 1 }));

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runAddCommand: vi.fn(),
          runQueueCommand: runQueueCommandMock,
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({ totalLinks: 0, processedCount: 0, pendingCount: 0, failedCount: 0 })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: actual.CliRunnerError,
        };
      });
    });

    const replies: string[] = [];
    // Simulate a posted status message object with edit/delete
    const statusMessage: any = {
      id: "status-1",
      content: "",
      edit: vi.fn(async (text: string) => { statusMessage.content = String(text); }),
      delete: vi.fn(async () => { statusMessage.deleted = true; }),
    };

    let replyCallCount = 0;
    const message: any = {
      content: "crawl https://crawl.example/start",
      author: { id: "author-1" },
      id: "message-1",
      channelId: "channel-1",
      client: { user: { id: "bot-user-1" } },
      react: vi.fn(async (_emoji: string) => undefined),
      reply: vi.fn(async (text: string) => {
        replies.push(String(text));
        replyCallCount++;
        // First reply (status) returns a message-like object so the presenter can edit it
        if (replyCallCount === 1) return statusMessage;
        // subsequent replies return a plain value
        return undefined;
      }),
      startThread: vi.fn(),
      reactions: { cache: new Map<string, any>() },
    };

    await onMonitoredMessage(message);

    expect(runQueueCommandMock).toHaveBeenCalledWith("https://crawl.example/start", {
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "author-1",
    });

    // Expect initial status posted and then a queued reply
    expect(replies.length).toBeGreaterThanOrEqual(1);
    // Verify presenter attempted to edit the initially posted status to reflect queued state
    expect(statusMessage.edit).toHaveBeenCalled();
    // And the presenter cleared (deleted) the status message
    expect(statusMessage.delete).toHaveBeenCalled();
    // Reaction updates occurred
    expect(message.react).toHaveBeenCalledWith("👀");
    expect(message.react).toHaveBeenCalledWith("✅");
  });

  it("posts a status message, updates it on failure, and clears it", async () => {
    const runQueueCommandMock = vi.fn(async (url: string, _opts?: any) => ({ success: false, url, error: "boom" }));

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          runAddCommand: vi.fn(),
          runQueueCommand: runQueueCommandMock,
          runSummaryCommand: vi.fn(),
          runStatsCommand: vi.fn(async () => ({ totalLinks: 0, processedCount: 0, pendingCount: 0, failedCount: 0 })),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: actual.CliRunnerError,
        };
      });
    });

    const replies: string[] = [];
    const statusMessage: any = {
      id: "status-2",
      content: "",
      edit: vi.fn(async (text: string) => { statusMessage.content = String(text); }),
      delete: vi.fn(async () => { statusMessage.deleted = true; }),
    };

    let replyCallCount = 0;
    const message: any = {
      content: "crawl https://crawl.example/start",
      author: { id: "author-1" },
      id: "message-2",
      channelId: "channel-1",
      client: { user: { id: "bot-user-1" } },
      react: vi.fn(async (_emoji: string) => undefined),
      reply: vi.fn(async (text: string) => {
        replies.push(String(text));
        replyCallCount++;
        if (replyCallCount === 1) return statusMessage;
        return undefined;
      }),
      startThread: vi.fn(),
      reactions: { cache: new Map<string, any>() },
    };

    await onMonitoredMessage(message);

    expect(runQueueCommandMock).toHaveBeenCalled();
    // Presenter should have edited the initial status to include failure note
    expect(statusMessage.edit).toHaveBeenCalled();
    expect(statusMessage.delete).toHaveBeenCalled();
    expect(message.react).toHaveBeenCalledWith("👀");
    expect(message.react).toHaveBeenCalledWith("⚠️");
  });
});
