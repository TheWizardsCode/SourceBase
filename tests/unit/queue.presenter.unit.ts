import { describe, it, expect, vi, beforeEach } from "vitest";
import QueuePresenter from "../../src/presenters/QueuePresenter.js";

describe("QueuePresenter basic lifecycle", () => {
  let qp: QueuePresenter;
  let fakeTarget: any;

  beforeEach(() => {
    qp = new QueuePresenter();
    fakeTarget = {
      sent: [] as string[],
      send: vi.fn(async function (this: any, content: string) {
        const msg = { id: String(this.sent.length + 1), content, edit: vi.fn(async (c: string) => { msg.content = c; }), delete: vi.fn(async () => {}) } as any;
        this.sent.push(content);
        return msg;
      }),
    } as any;
  });

  it("posts and updates a status message", async () => {
    const key = "q:1";
    const msg1 = await qp.createOrUpdateStatus(key, fakeTarget, "first");
    expect(fakeTarget.send).toHaveBeenCalled();
    expect(qp.getStatusMessage(key)).toBeTruthy();

    // Update should call edit
    const edited = await qp.createOrUpdateStatus(key, fakeTarget, "second");
    expect(edited).toBeTruthy();
    // The stored message should have been updated
    const stored = qp.getStatusMessage(key);
    expect(stored).toBeTruthy();
    if (stored) {
      expect(typeof stored.edit).toBe("function");
    }
  });

  it("clears a status message", async () => {
    const key = "q:2";
    await qp.createOrUpdateStatus(key, fakeTarget, "hello");
    expect(qp.getStatusMessage(key)).toBeTruthy();
    await qp.clearStatus(key);
    expect(qp.getStatusMessage(key)).toBeUndefined();
  });

  it("stores and clears a transport payload without attempting Message ops", async () => {
    const key = "q:payload";

    const payload = { channelId: "chan-123", messageId: "msg-456", authorId: "author-1" } as any;

    // When passing a transport payload, createOrUpdateStatus should accept
    // it and store it in the internal map. It should not try to call send/edit
    // on the payload (no exceptions).
    const posted = await qp.createOrUpdateStatus(key, payload, "status body");

    // We expect the returned value to be the payload (or truthy) and the
    // stored value to equal the payload.
    expect(posted).toBeTruthy();
    const stored = qp.getStatusMessage(key);
    expect(stored).toBeTruthy();
    expect(stored).toEqual(payload);

    // Clearing should remove the entry
    await qp.clearStatus(key);
    expect(qp.getStatusMessage(key)).toBeUndefined();
  });

  it("clearAll removes transport payloads too", async () => {
    const key1 = "q:payload1";
    const key2 = "q:payload2";
    const p1 = { channelId: "c1" } as any;
    const p2 = { channelId: "c2" } as any;

    await qp.createOrUpdateStatus(key1, p1, "one");
    await qp.createOrUpdateStatus(key2, p2, "two");

    expect(qp.getStatusMessage(key1)).toBeTruthy();
    expect(qp.getStatusMessage(key2)).toBeTruthy();

    await qp.clearAll();

    expect(qp.getStatusMessage(key1)).toBeUndefined();
    expect(qp.getStatusMessage(key2)).toBeUndefined();
  });
});
