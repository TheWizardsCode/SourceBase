import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal helper copied/adapted from tests/index.test.ts to capture the
// onMonitoredMessage handler exported to the Discord bot initializer.
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
    if (setupAdditionalMocks) {
      await setupAdditionalMocks();
    }

    // Import the module under test after mocking to allow our mocks to be
    // picked up by the module loader.
    await import("../src/index.js");
  } finally {
    processOnSpy.mockRestore();
  }

  if (!capturedOptions) throw new Error("Failed to capture onMonitoredMessage handler");

  const handler = (capturedOptions as any).onMonitoredMessage;
  if (typeof handler !== "function") throw new Error("Failed to capture onMonitoredMessage handler");

  return handler as (message: any) => Promise<void>;
}

function createFakeMessage(content: string, overrides: { channelId?: string; messageId?: string; authorId?: string } = {}) {
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

describe("ob add message handler failure modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("replies with helpful message when referenced message cannot be fetched", async () => {
    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {}
        return {
          runAddCommand: vi.fn(),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    const { message, replies } = createFakeMessage("ob add");

    // Simulate a reply reference but fetching the referenced message fails
    message.reference = { messageId: "ref-1" };
    message.channel = { messages: { fetch: vi.fn().mockRejectedValue(new Error("nope")) } };

    await onMonitoredMessage(message);

    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("couldn't fetch the message");
  });

  it("rejects oversized inline payloads with an explanatory message", async () => {
    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {}
        return {
          runAddCommand: vi.fn(),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });
    });

    // Create a payload larger than the default 64KiB limit
    const largeText = "ob add " + "x".repeat(70 * 1024);
    const { message, replies } = createFakeMessage(largeText);

    await onMonitoredMessage(message);

    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("Text too large to ingest directly");
  });

  it("reports temp-file write failures to the user", async () => {
    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      await vi.doMock("../src/bot/cli-runner.js", () => {
        class MockCliRunnerError extends Error {}
        return {
          runAddCommand: vi.fn(),
          runQueueCommand: vi.fn(),
          runSummaryCommand: vi.fn(),
          isCliAvailable: vi.fn(async () => true),
          CliRunnerError: MockCliRunnerError,
        };
      });

      // Ensure we return a deterministic temp file path
      await vi.doMock("../src/discord/utils.js", () => ({
        makeTempFileName: (prefix = "briefing", ext = "md") => "/tmp/fake-ob-add.txt",
        buildCliErrorReport: () => "",
      }));

      // Mock fs/promises to simulate write failure
      await vi.doMock("fs/promises", () => ({
        writeFile: vi.fn().mockRejectedValue(new Error("no space")),
        unlink: vi.fn().mockResolvedValue(undefined),
      }));
    });

    const { message, replies } = createFakeMessage("ob add small payload");

    await onMonitoredMessage(message);

    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("Failed to prepare temporary file for ingestion");
  });
});
