import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Discord message handler spawn ENOENT integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  it("should reply with friendly CLI unavailable message when add spawn fails with ENOENT", async () => {
    // Mock child_process.spawn to succeed for --version but fail for add
    await vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
      const events = await vi.importActual<typeof import("events")>("events");
      const stream = await vi.importActual<typeof import("stream")>("stream");

      function makeFakeChild() {
        const child = new events.EventEmitter();
        const stdout = new stream.Readable({ read() {} });
        const stderr = new stream.Readable({ read() {} });
        (child as any).stdout = stdout;
        (child as any).stderr = stderr;
        (child as any).exitCode = null;
        (child as any).signalCode = null;
        (child as any).kill = (signal?: string) => {
          setTimeout(() => child.emit("exit", 0), 0);
          return true;
        };
        return child as unknown as import("child_process").ChildProcess;
      }

      const mockSpawn = (exe: string, args: string[], opts: any) => {
        const child = makeFakeChild();

        setTimeout(() => {
          if (args && args[0] === "add") {
            const err: NodeJS.ErrnoException = new Error("spawn ENOENT");
            err.code = "ENOENT";
            (child as any).emit("error", err);
            try {
              (child as any).stdout.push(null);
              (child as any).stderr.push(null);
            } catch {}
          } else {
            // Simulate --version success
            (child as any).stdout.push("v1.2.3\n");
            (child as any).stdout.push(null);
            setTimeout(() => child.emit("exit", 0), 0);
          }
        }, 0);

        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    // Mock DiscordBot to capture the passed handlers without starting network
    await vi.doMock("../src/discord/client.js", async () => {
      let lastOpts: any = null;

      class MockDiscordBot {
        constructor(opts: any) {
          lastOpts = opts;
        }

        async start() {
          // no-op to avoid network
          return;
        }
      }

      return {
        DiscordBot: MockDiscordBot,
        __getLastOpts: () => lastOpts,
      };
    });

    // Import the app (this will instantiate the mocked DiscordBot)
    const app = await import("../src/index.js");

    // Retrieve the captured DiscordBot options to get the onMonitoredMessage handler
    const discordModule = await import("../src/discord/client.js");
    const lastOpts = (discordModule as any).__getLastOpts();
    expect(lastOpts).toBeTruthy();

    const onMonitoredMessage = lastOpts.onMonitoredMessage as (msg: any) => Promise<void>;
    expect(typeof onMonitoredMessage).toBe("function");

    // Build a fake message object
    const replies: string[] = [];
    const fakeThread = {
      id: "thread1",
      send: vi.fn(async (text: string) => replies.push(String(text))),
      setArchived: vi.fn(async (val: boolean) => {}),
    };

    const fakeMessage: any = {
      content: "https://x.example",
      author: { id: "author1" },
      id: "msg1",
      channelId: "channel1",
      client: { user: { id: "botUser" } },
      react: vi.fn(async () => {}),
      reply: vi.fn(async (text: string) => replies.push(String(text))),
      startThread: vi.fn(async (opts: any) => fakeThread),
      reactions: { cache: new Map() },
    };

    // Call the handler and ensure it does not throw
    await expect(onMonitoredMessage(fakeMessage)).resolves.not.toThrow();

    // The bot should have replied with the friendly CLI unavailable message
    const found = replies.find((r) => typeof r === "string" && r.includes("OpenBrain CLI is not available"));
    expect(found).toBeTruthy();
  });
});
