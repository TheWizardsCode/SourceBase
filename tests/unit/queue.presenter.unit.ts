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
});
