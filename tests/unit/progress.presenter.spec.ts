import { describe, expect, it, vi, beforeEach } from "vitest";
import { ProgressPresenter } from "../../src/presenters/progress.js";
import type { AddProgressEvent } from "../../src/bot/cli-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeMessage(overrides: { id?: string } = {}) {
  const replies: string[] = [];
  const message: any = {
    id: overrides.id ?? "msg-1",
    reply: vi.fn(async (text: string) => {
      const m = { content: String(text), edit: vi.fn() };
      replies.push(String(text));
      return m;
    }),
    channel: {},
    client: { user: { id: "bot-1" } },
  };
  return { message, replies };
}

function makeThread(overrides: { id?: string; failSend?: boolean } = {}) {
  const messages: string[] = [];
  const thread: any = {
    id: overrides.id ?? "thread-1",
    send: vi.fn(async (text: string) => {
      if (overrides.failSend) throw new Error("thread send failed");
      const m = { content: String(text), edit: vi.fn() };
      messages.push(String(text));
      return m;
    }),
    setArchived: vi.fn(async () => undefined),
  };
  return { thread, messages };
}

function event(phase: string, extras: Partial<AddProgressEvent> = {}): AddProgressEvent {
  return { phase, url: "https://example.com", ...extras } as AddProgressEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProgressPresenter", () => {
  describe("handleProgressEvent – phase deduplication", () => {
    it("posts a message for the first event", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      const posted = await presenter.handleProgressEvent(event("downloading"));

      expect(posted).toBe(true);
      expect(message.reply).toHaveBeenCalledTimes(1);
      expect(message.reply.mock.calls[0][0]).toContain("⏳ Downloading content...");
    });

    it("does NOT post when the same phase is repeated", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      const second = await presenter.handleProgressEvent(event("downloading"));

      expect(second).toBe(false);
      expect(message.reply).toHaveBeenCalledTimes(1);
    });

    it("posts again when the phase changes", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      const second = await presenter.handleProgressEvent(event("extracting"));

      expect(second).toBe(true);
      expect(message.reply).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleProgressEvent – terminal phase suppression", () => {
    it("suppresses events after a 'completed' phase", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("completed", { title: "My Article" }));
      const suppressed = await presenter.handleProgressEvent(event("some-other-phase"));

      expect(suppressed).toBe(false);
      expect(message.reply).toHaveBeenCalledTimes(1);
    });

    it("suppresses events after a 'failed' phase", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("failed", { message: "oops" }));
      const suppressed = await presenter.handleProgressEvent(event("downloading"));

      expect(suppressed).toBe(false);
      expect(message.reply).toHaveBeenCalledTimes(1);
    });

    it("marks isTerminalPhaseSeen() true after 'completed'", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      expect(presenter.isTerminalPhaseSeen()).toBe(false);
      await presenter.handleProgressEvent(event("completed", { title: "T" }));
      expect(presenter.isTerminalPhaseSeen()).toBe(true);
    });
  });

  describe("handleProgressEvent – thread vs channel posting", () => {
    it("posts to thread when a thread is provided", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const { thread, messages } = makeThread();
      const presenter = new ProgressPresenter(thread, message, logger);

      await presenter.handleProgressEvent(event("downloading"));

      expect(thread.send).toHaveBeenCalledTimes(1);
      expect(message.reply).not.toHaveBeenCalled();
      expect(messages[0]).toContain("⏳ Downloading content...");
    });

    it("falls back to channel reply when thread.send() fails", async () => {
      const logger = makeLogger();
      const { message, replies } = makeMessage();
      const { thread } = makeThread({ failSend: true });
      const presenter = new ProgressPresenter(thread, message, logger);

      await presenter.handleProgressEvent(event("downloading"));

      expect(thread.send).toHaveBeenCalledTimes(1);
      expect(message.reply).toHaveBeenCalledTimes(1);
      expect(replies[0]).toContain("⏳ Downloading content...");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to channel reply"),
        expect.any(Object)
      );
    });

    it("posts to channel reply when no thread is given", async () => {
      const logger = makeLogger();
      const { message, replies } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("extracting"));

      expect(message.reply).toHaveBeenCalledTimes(1);
      expect(replies[0]).toContain("📝 Extracting text content...");
    });
  });

  describe("statusMessages Map", () => {
    it("tracks posted messages by phase key", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const { thread } = makeThread();
      const presenter = new ProgressPresenter(thread, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      await presenter.handleProgressEvent(event("extracting"));

      const statusMessages = presenter.getStatusMessages();
      expect(statusMessages.size).toBe(2);
      expect(statusMessages.has("downloading")).toBe(true);
      expect(statusMessages.has("extracting")).toBe(true);
    });

    it("only has one entry per phase (deduplication does not add multiple)", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      await presenter.handleProgressEvent(event("downloading")); // duplicate

      expect(presenter.getStatusMessages().size).toBe(1);
    });

    it("returns a read-only view", () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      const map = presenter.getStatusMessages();
      expect(map).toBeInstanceOf(Map);
    });
  });

  describe("getLastPhase()", () => {
    it("returns null before any event is handled", () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);
      expect(presenter.getLastPhase()).toBeNull();
    });

    it("returns the latest phase after handling events", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      expect(presenter.getLastPhase()).toBe("downloading");

      await presenter.handleProgressEvent(event("embedding"));
      expect(presenter.getLastPhase()).toBe("embedding");
    });
  });

  describe("getLastPostedMessage()", () => {
    it("returns null before any event is handled", () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);
      expect(presenter.getLastPostedMessage()).toBeNull();
    });

    it("returns the Discord message object returned by reply/send", async () => {
      const logger = makeLogger();
      const { message } = makeMessage();
      const { thread } = makeThread();
      const presenter = new ProgressPresenter(thread, message, logger);

      await presenter.handleProgressEvent(event("downloading"));
      const last = presenter.getLastPostedMessage();
      expect(last).not.toBeNull();
      expect(last).toHaveProperty("content");
    });
  });

  describe("appendItemLink and editing behavior", () => {
    it("records lastPostedMessage and appends item link by editing when possible", async () => {
      const editMock = vi.fn(async (newContent: string) => ({ id: "posted-1", content: newContent }));
      const postedMessage = { id: "posted-1", content: "Completed message", edit: editMock };
      const threadSendMock = vi.fn(async (_content: string) => postedMessage);
      const thread = { id: "thread-1", send: threadSendMock } as any;

      const presenter = new ProgressPresenter(thread, makeMessage().message, makeLogger());
      await presenter.handleProgressEvent(event("completed", { title: "Some Title" }));

      const last = presenter.getLastPostedMessage();
      expect(last).toBe(postedMessage);

      await presenter.appendItemLink("https://openbrain/item/55", 55, "success fallback");
      expect(editMock).toHaveBeenCalledTimes(1);
      const calledWith = editMock.mock.calls[0][0] as string;
      expect(calledWith).toContain("OpenBrain item");
      expect(calledWith).toContain("55");
    });

    it("falls back to posting the item link when editing is not available", async () => {
      const sendMock = vi.fn(async (content: string) => ({ id: "fallback-1", content }));
      const presenter = new ProgressPresenter({ send: sendMock } as any, makeMessage().message, makeLogger());

      await presenter.appendItemLink("https://openbrain/item/33", 33);
      expect(sendMock).toHaveBeenCalledWith("✅ OpenBrain item: <https://openbrain/item/33>");
    });
  });

  describe("progress message formatting", () => {
    it("formats known phases with correct emojis", async () => {
      const logger = makeLogger();
      const cases: [string, string][] = [
        ["downloading", "⏳ Downloading content..."],
        ["extracting", "📝 Extracting text content..."],
        ["embedding", "🧠 Generating embeddings..."],
      ];

      for (const [phase, expected] of cases) {
        const { message, replies } = makeMessage();
        const presenter = new ProgressPresenter(null, message, logger);
        await presenter.handleProgressEvent(event(phase));
        expect(replies[0]).toBe(expected);
      }
    });

    it("wraps event.title in backticks in the posted message", async () => {
      const logger = makeLogger();
      const { message, replies } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(
        event("completed", { title: "My Article Title" })
      );

      expect(replies[0]).toContain("`My Article Title`");
    });

    it("wraps event.url in backticks when no title is present", async () => {
      const logger = makeLogger();
      const { message, replies } = makeMessage();
      const presenter = new ProgressPresenter(null, message, logger);

      await presenter.handleProgressEvent(
        event("failed", { message: "network error", url: "https://example.com" })
      );

      expect(replies[0]).toContain("❌ Failed: network error");
    });
  });
});
