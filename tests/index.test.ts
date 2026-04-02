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

  it("passes context flags to spawn for ob add", async () => {
    const spawnCalls: Array<{ exe: string; args: string[]; opts: unknown }> = [];

    const onMonitoredMessage = await loadMonitoredMessageHandler(async () => {
      vi.doUnmock("../src/bot/cli-runner.js");

      await vi.doMock("child_process", async () => {
        const actual = await vi.importActual<typeof import("child_process")>("child_process");
        const events = await vi.importActual<typeof import("events")>("events");
        const stream = await vi.importActual<typeof import("stream")>("stream");

        function makeFakeChild(): import("child_process").ChildProcess {
          const child = new events.EventEmitter();
          const stdout = new stream.Readable({ read() {} });
          const stderr = new stream.Readable({ read() {} });
          (child as any).stdout = stdout;
          (child as any).stderr = stderr;
          (child as any).exitCode = null;
          (child as any).signalCode = null;
          (child as any).kill = (_signal?: string) => {
            setTimeout(() => child.emit("exit", 0), 0);
            return true;
          };
          return child as unknown as import("child_process").ChildProcess;
        }

        const mockSpawn = (exe: string, args: string[], opts: unknown) => {
          spawnCalls.push({ exe, args, opts });
          const child = makeFakeChild();

          setTimeout(() => {
            if (args[0] === "--version") {
              (child as any).stdout.push("v1.2.3\n");
            } else if (args[0] === "add") {
              (child as any).stdout.push(
                `${JSON.stringify({ phase: "completed", url: "https://ctx.example/item", title: "Ctx Title" })}\n`
              );
            }

            (child as any).stdout.push(null);
            (child as any).stderr.push(null);
            setTimeout(() => child.emit("exit", 0), 0);
          }, 0);

          return child;
        };

        return { ...actual, spawn: mockSpawn };
      });
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
    const channelIdx = addArgs.indexOf("--channel-id");
    const messageIdx = addArgs.indexOf("--message-id");
    const authorIdx = addArgs.indexOf("--author-id");

    expect(channelIdx).toBeGreaterThan(-1);
    expect(messageIdx).toBeGreaterThan(-1);
    expect(authorIdx).toBeGreaterThan(-1);

    expect(addArgs[channelIdx + 1]).toBe("channel-xyz");
    expect(addArgs[messageIdx + 1]).toBe("message-xyz");
    expect(addArgs[authorIdx + 1]).toBe("author-xyz");
    expect(addArgs).toContain("https://ctx.example/item");
  });
});
