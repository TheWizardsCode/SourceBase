import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Discord message handler spawn ENOENT integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  it("should reply with friendly CLI unavailable message when add spawn fails with ENOENT", async () => {
    // Mock child_process.spawn to succeed for --version but fail for add
    const helper = await import("./helpers/mockCliSpawn.js");
    // Compose a custom mock that errors for `add` and returns version for others
    const { mockSpawn: versionSpawn } = helper.createSpawnMockVersion();
    const { mockSpawn: errorSpawn } = helper.createSpawnMockSpawnError("ENOENT");
    const compositeSpawn = (exe: string, args: string[], opts: any) => {
      if (args && args[0] === "add") {
        return errorSpawn(exe, args, opts);
      }
      return versionSpawn(exe, args, opts);
    };
    await helper.doMockChildProcess(vi, compositeSpawn);

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
