import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressPresenter } from "../../src/presenters/progress.js";

describe("ProgressPresenter", () => {
  let threadSendMock: any;
  let thread: any;
  let message: any;
  let logger: any;

  beforeEach(() => {
    threadSendMock = vi.fn(async (content: string) => {
      return { id: "posted-1", content, edit: vi.fn(async (_c: string) => undefined) };
    });
    thread = { id: "thread-1", send: threadSendMock };
    message = { id: "message-1", reply: vi.fn(async (content: string) => ({ id: "reply-1", content, edit: vi.fn(async (_c: string) => undefined) })), client: { user: { id: "bot-1" } } };
    logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
  });

  it("deduplicates successive events with the same phase", async () => {
    const presenter = new ProgressPresenter(thread, message, logger);

    const first = await presenter.handleProgressEvent({ phase: "downloading", url: "https://x" } as any);
    expect(first).toBe(true);
    expect(threadSendMock).toHaveBeenCalledTimes(1);

    const second = await presenter.handleProgressEvent({ phase: "downloading", url: "https://x" } as any);
    expect(second).toBe(false);
    expect(threadSendMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses events after a terminal phase", async () => {
    const presenter = new ProgressPresenter(thread, message, logger);

    const ok = await presenter.handleProgressEvent({ phase: "completed", title: "T" } as any);
    expect(ok).toBe(true);
    expect(presenter.isTerminalPhaseSeen()).toBe(true);
    expect(threadSendMock).toHaveBeenCalledTimes(1);

    const suppressed = await presenter.handleProgressEvent({ phase: "extracting" } as any);
    expect(suppressed).toBe(false);
    expect(threadSendMock).toHaveBeenCalledTimes(1);
  });

  it("records lastPostedMessage and appends item link by editing when possible", async () => {
    const editMock = vi.fn(async (newContent: string) => ({ id: "posted-1", content: newContent }));
    const postedMessage = { id: "posted-1", content: "Completed message", edit: editMock };
    threadSendMock = vi.fn(async (_content: string) => postedMessage);
    thread = { id: "thread-1", send: threadSendMock };

    const presenter = new ProgressPresenter(thread, message, logger);
    await presenter.handleProgressEvent({ phase: "completed", title: "Some Title" } as any);

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
    const presenter = new ProgressPresenter({ send: sendMock }, message, logger);

    await presenter.appendItemLink("https://openbrain/item/33", 33);
    expect(sendMock).toHaveBeenCalledWith("✅ OpenBrain item: <https://openbrain/item/33>");
  });

  it("postMessage posts and records lastPostedMessage", async () => {
    const ret = { id: "m3", content: "hello", edit: vi.fn() };
    threadSendMock = vi.fn(async (_content: string) => ret);
    thread = { id: "thread-1", send: threadSendMock };

    const presenter = new ProgressPresenter(thread, message, logger);
    const posted = await presenter.postMessage("hi there");
    expect(posted).toBe(ret);
    expect(presenter.getLastPostedMessage()).toBe(ret);
  });
});
