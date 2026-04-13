import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendWithFallback } from "../../src/presenters/QueuePresenter.js";

describe("sendWithFallback", () => {
  let logger: any;

  beforeEach(() => {
    logger = { warn: vi.fn(), debug: vi.fn() } as any;
  });

  it("uses target.send when available", async () => {
    const target = { send: vi.fn(async (body: string) => ({ id: "m1", content: body })) } as any;
    const res = await sendWithFallback(target, "hello", logger);
    expect(target.send).toHaveBeenCalledWith("hello");
    expect(res).toBeTruthy();
    expect(res.id).toBe("m1");
  });

  it("falls back to lastPostedMessage.edit when target.send throws", async () => {
    const target = { send: vi.fn(async () => { throw new Error("send failed"); }) } as any;
    const lastPosted = { edit: vi.fn(async (body: string) => { lastPosted.content = body; return lastPosted; }), content: "old" } as any;

    const res = await sendWithFallback(target, "updated", logger, lastPosted);
    // send attempted then edit called
    expect(target.send).toHaveBeenCalled();
    expect(lastPosted.edit).toHaveBeenCalledWith("updated");
    expect(res).toBe(lastPosted);
  });

  it("falls back to channel.send when send and edit both fail", async () => {
    const target = { send: vi.fn(async () => { throw new Error("send fail"); }), channel: { send: vi.fn(async (b: string) => ({ id: "chanmsg", content: b })) } } as any;
    const lastPosted = { edit: vi.fn(async () => { throw new Error("edit fail"); }) } as any;

    const res = await sendWithFallback(target, "body", logger, lastPosted);
    expect(target.send).toHaveBeenCalled();
    expect(lastPosted.edit).toHaveBeenCalled();
    expect(target.channel.send).toHaveBeenCalledWith("body");
    expect(res).toBeTruthy();
    expect(res.id).toBe("chanmsg");
  });

  it("returns transport payload and does not attempt runtime sends", async () => {
    const payload = { channelId: "c1", messageId: "m1" } as any;
    const res = await sendWithFallback(payload, "body", logger);
    expect(res).toBe(payload);
    // logger.debug should be called about deferring
    expect(logger.debug).toHaveBeenCalled();
  });

  it("logs a single structured warning when all attempts throw", async () => {
    const target = { send: vi.fn(async () => { throw new Error("send fail"); }), channel: { send: vi.fn(async () => { throw new Error("chan fail"); }) } } as any;
    const lastPosted = { edit: vi.fn(async () => { throw new Error("edit fail"); }) } as any;

    const res = await sendWithFallback(target, "body", logger, lastPosted);
    expect(res).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    const call = logger.warn.mock.calls[0];
    // the structured object should be the second argument
    expect(call.length).toBeGreaterThanOrEqual(2);
    const structured = call[1];
    expect(structured).toHaveProperty("originalError");
    expect(structured).toHaveProperty("targetId");
  });
});
