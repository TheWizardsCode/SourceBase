import { describe, it, expect, vi, beforeEach } from "vitest";
import { postCliErrorReport } from "../../src/discord/cli-error-report.js";

function makeTarget() {
  const calls: any[] = [];
  return {
    calls,
    send: vi.fn(async (arg: any) => { calls.push({ method: "send", arg }); }),
    reply: vi.fn(async (arg: any) => { calls.push({ method: "reply", arg }); }),
  };
}

describe("postCliErrorReport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends inline when small", async () => {
    const t = makeTarget();
    const rpt = "short report";
    await postCliErrorReport(t, rpt, "intro");
    expect(t.send).toHaveBeenCalled();
    const call = t.calls[0];
    expect(call.method).toBe("send");
    expect(call.arg).toBe(rpt);
  });

  it("attaches when large", async () => {
    const t = makeTarget();
    const rpt = "x".repeat(5000);
    await postCliErrorReport(t, rpt, "intro");
    expect(t.send).toHaveBeenCalled();
    const call = t.calls[0];
    expect(call.method).toBe("send");
    expect(call.arg).toHaveProperty("content");
    expect(call.arg).toHaveProperty("files");
    expect(Array.isArray(call.arg.files)).toBe(true);
    expect(call.arg.files[0].name).toBe("cli-error-report.txt");
  });

  it("falls back to reply when send missing", async () => {
    const t: any = { reply: vi.fn(async (a: any) => { t._last = a; }) };
    const rpt = "short";
    await postCliErrorReport(t, rpt, "intro");
    expect(t.reply).toHaveBeenCalled();
    expect(t._last).toBe(rpt);
  });

  it("graceful when target throws on send with large report", async () => {
    const t = makeTarget();
    t.send.mockImplementationOnce(async () => { throw new Error("boom"); });
    const rpt = "x".repeat(5000);
    await postCliErrorReport(t, rpt, "intro");
    // Should attempt fallback truncated inline send/reply
    expect(t.send.mock.calls.length + t.reply.mock.calls.length).toBeGreaterThan(0);
  });
});
