import { describe, it, expect, vi, beforeEach } from "vitest";
import resolveTransportPayloadToTarget from "../../src/presenters/QueueTransportAdapter.js";

describe("QueueTransportAdapter", () => {
  let fakeClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient = {
      channels: {
        fetch: vi.fn(async (id: string) => {
          if (id === "chan-1") {
            return {
              id: "chan-1",
              send: vi.fn(async (text: string) => ({ id: "sent-1", content: text })),
            };
          }
          if (id === "chan-2") {
            return {
              id: "chan-2",
              messages: {
                fetch: vi.fn(async (mid: string) => ({ id: mid, reply: vi.fn(async (t: string) => ({ id: "r-" + mid, content: t })) })),
              },
            };
          }
          return null;
        }),
      },
    } as any;
  });

  it("resolves to channel send adapter when channel exists", async () => {
    const payload = { channelId: "chan-1" };
    const target = await resolveTransportPayloadToTarget(fakeClient, payload as any);
    expect(target).toBeTruthy();
    expect(target?.id).toBe("chan-1");
    await expect(target?.send("hello")).resolves.toHaveProperty("content", "hello");
  });

  it("resolves to message reply adapter when channel+message exists", async () => {
    const payload = { channelId: "chan-2", messageId: "msg-1" };
    const target = await resolveTransportPayloadToTarget(fakeClient, payload as any);
    expect(target).toBeTruthy();
    expect(target?.id).toBe("msg-1");
    await expect(target?.send("hi")).resolves.toHaveProperty("content", "hi");
  });

  it("returns null when resolution fails", async () => {
    const payload = { channelId: "missing" };
    const target = await resolveTransportPayloadToTarget(fakeClient, payload as any);
    expect(target).toBeNull();
  });
});
