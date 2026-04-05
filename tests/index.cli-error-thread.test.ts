import { describe, it, expect, vi, beforeEach } from "vitest";

describe("CLI error posting to thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  it("creates/uses a thread and posts RCA report when CLI add fails with stderr", async () => {
    const helper = await import("./helpers/mockCliSpawn.js");

    // Return success for --version checks, but simulate an error for `add`
    const { mockSpawn: versionSpawn } = helper.createSpawnMockVersion();
    const { mockSpawn: errorSpawn } = helper.createSpawnMockWithStderr(["simulated error output"], 2);

    const compositeSpawn = (exe: string, args: string[], opts: any) => {
      if (args && args[0] === "add") return errorSpawn(exe, args, opts);
      return versionSpawn(exe, args, opts);
    };

    await helper.doMockChildProcess(vi, compositeSpawn);

    // Mock DiscordBot to capture handlers without starting network
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
    await import("../src/index.js");

    // Retrieve the captured DiscordBot options to get the onMonitoredMessage handler
    const discordModule = await import("../src/discord/client.js");
    const lastOpts = (discordModule as any).__getLastOpts();
    expect(lastOpts).toBeTruthy();

    const onMonitoredMessage = lastOpts.onMonitoredMessage as (msg: any) => Promise<void>;
    expect(typeof onMonitoredMessage).toBe("function");

    const replies: any[] = [];
    const fakeThread = {
      id: "thread1",
      send: vi.fn(async (text: any) => replies.push(text)),
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
      // Ensure createThreadForMessage falls back to channel.threads.create()
      channel: { threads: { create: vi.fn(async (opts: any) => fakeThread) } },
      reactions: { cache: new Map() },
    };

    // Call the handler and ensure it does not throw
    await expect(onMonitoredMessage(fakeMessage)).resolves.not.toThrow();

    // The thread should have received a diagnostic report and been archived
    expect(fakeThread.send).toHaveBeenCalled();

    const sentArgs = fakeThread.send.mock.calls.map((c: any) => c[0]);
    const hasReport = sentArgs.some((a: any) => typeof a === "string" && a.includes("CLI Error Report"));
    expect(hasReport).toBe(true);

    expect(fakeThread.setArchived).toHaveBeenCalled();

    // Message.reply should not have been used for the final diagnostic
    expect(fakeMessage.reply.mock.calls.length).toBe(0);
  });
});
