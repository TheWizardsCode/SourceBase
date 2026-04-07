import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as wait } from "timers/promises";

// Helper to create a mocked interaction object for button clicks
function makeButtonInteraction(overrides: any = {}) {
  const edits: any[] = [];
  const replies: any[] = [];

  const message = overrides.message || {
    id: overrides.messageId || "bot-reply-1",
    content: overrides.content || "Briefing body here",
    attachments: overrides.attachments || { size: 0 },
  };

  const interaction: any = {
    isButton: () => true,
    customId: "save_briefing",
    deferReply: vi.fn(async (_opts?: any) => undefined),
    editReply: vi.fn(async (payload: any) => edits.push(payload)),
    reply: vi.fn(async (payload: any) => replies.push(payload)),
    fetchReply: vi.fn(async () => message),
    user: { id: overrides.userId || "user-1" },
    channelId: overrides.channelId || "channel-1",
    message,
  };

  return { interaction, edits, replies, message };
}

describe("Save briefing button interaction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Clear any captured handler from previous imports
    delete (global as any).__ON_INTERACTION_CAPTURE__;
  });

  it("saves briefing from .md attachment and returns link on success", async () => {
    // Mock fetch to return attachment body
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => "# Summary\n\nAttachment body" } as any));

    // Mock runCliCommand to return stdout containing an id
    await vi.doMock("../src/bot/cli-runner.js", () => ({
      runCliCommand: vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: [JSON.stringify({ id: 123 })], stderr: "", exitCode: 0 })),
      runAddCommand: vi.fn(),
      runQueueCommand: vi.fn(),
      runSummaryCommand: vi.fn(),
      isCliAvailable: vi.fn(async () => true),
      CliRunnerError: class MockCliRunnerError extends Error {},
    }));

    // Mock Discord client to capture the onInteraction handler
    await vi.doMock("../src/discord/client.js", async () => {
      class MockDiscordBot {
        constructor(options: any) {
          // expose the captured handler for tests
          (global as any).__ON_INTERACTION_CAPTURE__ = options.onInteraction;
        }
        async start(): Promise<void> {
          return;
        }
      }

      return { DiscordBot: MockDiscordBot };
    });

    // Load the bot module (this will set __ON_INTERACTION_CAPTURE__)
    await import("../src/index.js");

    // Create interaction with an attachment
    const att = { url: "https://example.com/file.md", name: "briefing.md" };
    const { interaction, edits } = makeButtonInteraction({ message: { id: "reply-1", content: "", attachments: { size: 1, first: () => att } } });

    // Call the handler
    const captured = (global as any).__ON_INTERACTION_CAPTURE__ as any;
    if (!captured) throw new Error("Failed to capture onInteraction handler");
    await captured(interaction);

    // Allow async ops
    await wait(10);

    expect(edits.length).toBeGreaterThan(0);
    const last = edits[edits.length - 1];
    expect(String(last.content)).toContain("Briefing saved");
    expect(String(last.content)).toContain("123");
  });

  it("prevents concurrent ingestion and is idempotent across repeated clicks", async () => {
    // Mock fetch to return attachment body
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => "# Summary\n\nAttachment body" } as any));

    // Create a controllable promise for runCliCommand so we can simulate in-progress state
    let resolveRun: (val: any) => void = () => {};
    const runCliPromise = new Promise((res) => {
      resolveRun = res as any;
    });

    const runCliMock = vi.fn(() => runCliPromise);

    await vi.doMock("../src/bot/cli-runner.js", () => ({
      runCliCommand: runCliMock,
      runAddCommand: vi.fn(),
      runQueueCommand: vi.fn(),
      runSummaryCommand: vi.fn(),
      isCliAvailable: vi.fn(async () => true),
      CliRunnerError: class MockCliRunnerError extends Error {},
    }));

    // Mock Discord client to capture handler
    await vi.doMock("../src/discord/client.js", async () => {
      class MockDiscordBot {
        constructor(options: any) {
          (global as any).__ON_INTERACTION_CAPTURE__ = options.onInteraction;
        }
        async start(): Promise<void> {
          return;
        }
      }
      return { DiscordBot: MockDiscordBot };
    });

    await import("../src/index.js");
    const captured = (global as any).__ON_INTERACTION_CAPTURE__ as any;
    if (!captured) throw new Error("Failed to capture onInteraction handler");

    const att = { url: "https://example.com/file.md", name: "briefing.md" };
    const sharedMessage = { id: "reply-dup", content: "", attachments: { size: 1, first: () => att } };

    const { interaction: i1, edits: edits1 } = makeButtonInteraction({ message: sharedMessage });
    const { interaction: i2, edits: edits2 } = makeButtonInteraction({ message: sharedMessage });
    const { interaction: i3, edits: edits3 } = makeButtonInteraction({ message: sharedMessage });

    // Start the first invocation but don't await - it will be blocked on runCliPromise
    const p1 = captured(i1);

    // Give the event loop a tick so the first handler can set the 'saving' sentinel
    await wait(0);

    // Second click should detect 'saving' and return early
    await captured(i2);
    expect(edits2.length).toBeGreaterThan(0);
    expect(String(edits2[edits2.length - 1].content)).toContain("Briefing save already in progress");

    // Now resolve the CLI run with a successful id
    resolveRun({ stdout: [JSON.stringify({ id: 99 })], stderr: "", exitCode: 0 });
    await p1;

    // First interaction should now have a success reply
    expect(edits1.length).toBeGreaterThan(0);
    expect(String(edits1[edits1.length - 1].content)).toContain("Briefing saved");

    // A subsequent click should report already saved and include the id
    await captured(i3);
    expect(edits3.length).toBeGreaterThan(0);
    expect(String(edits3[edits3.length - 1].content)).toContain("Briefing already saved");
    expect(String(edits3[edits3.length - 1].content)).toContain("99");

    expect(runCliMock).toHaveBeenCalledTimes(1);
  });

  it("handles CLI failure and allows retry after failing ingestion", async () => {
    // Simulate fetch failing so the handler falls back to message content
    global.fetch = vi.fn(async () => {
      throw new Error("network error");
    });

    let callCount = 0;
    const runCliMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { stdout: [], stderr: "cli failed", exitCode: 1 };
      }
      return { stdout: [JSON.stringify({ id: 42 })], stderr: "", exitCode: 0 };
    });

    await vi.doMock("../src/bot/cli-runner.js", () => ({
      runCliCommand: runCliMock,
      runAddCommand: vi.fn(),
      runQueueCommand: vi.fn(),
      runSummaryCommand: vi.fn(),
      isCliAvailable: vi.fn(async () => true),
      CliRunnerError: class MockCliRunnerError extends Error {},
    }));

    await vi.doMock("../src/discord/client.js", async () => {
      class MockDiscordBot {
        constructor(options: any) {
          (global as any).__ON_INTERACTION_CAPTURE__ = options.onInteraction;
        }
        async start(): Promise<void> {
          return;
        }
      }
      return { DiscordBot: MockDiscordBot };
    });

    await import("../src/index.js");
    const captured = (global as any).__ON_INTERACTION_CAPTURE__ as any;
    if (!captured) throw new Error("Failed to capture onInteraction handler");

    const att = { url: "https://example.com/file.md", name: "briefing.md" };
    const sharedMessage = { id: "reply-fail", content: "fallback content", attachments: { size: 1, first: () => att } };

    const { interaction: i1, edits: edits1 } = makeButtonInteraction({ message: sharedMessage });
    // First attempt -> CLI failure
    await captured(i1);
    expect(edits1.length).toBeGreaterThan(0);
    expect(String(edits1[edits1.length - 1].content)).toContain("Failed to ingest briefing");

    // Second attempt -> should succeed
    const { interaction: i2, edits: edits2 } = makeButtonInteraction({ message: sharedMessage });
    await captured(i2);
    expect(edits2.length).toBeGreaterThan(0);
    expect(String(edits2[edits2.length - 1].content)).toContain("Briefing saved");
    expect(String(edits2[edits2.length - 1].content)).toContain("42");

    expect(runCliMock).toHaveBeenCalledTimes(2);
  });

  it("returns a helpful error when no briefing content is available", async () => {
    // No attachments and no message content -> handler should return an explanatory error
    await vi.doMock("../src/discord/client.js", async () => {
      class MockDiscordBot {
        constructor(options: any) {
          (global as any).__ON_INTERACTION_CAPTURE__ = options.onInteraction;
        }
        async start(): Promise<void> {
          return;
        }
      }

      return { DiscordBot: MockDiscordBot };
    });

    // Load the bot module (this will set __ON_INTERACTION_CAPTURE__)
    await import("../src/index.js");

    const { interaction, edits } = makeButtonInteraction({ message: { id: "reply-empty", content: "", attachments: { size: 0 } } });

    const captured = (global as any).__ON_INTERACTION_CAPTURE__ as any;
    if (!captured) throw new Error("Failed to capture onInteraction handler");
    await captured(interaction);

    expect(edits.length).toBeGreaterThan(0);
    const last = edits[edits.length - 1];
    expect(String(last.content)).toContain("Could not extract briefing text");
  });
});
