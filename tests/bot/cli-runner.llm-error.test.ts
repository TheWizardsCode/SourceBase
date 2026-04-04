import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("CLI Runner LLM error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import("../../src/bot/cli-runner.js");
    await mod.terminateAllChildProcesses();
  });

  it("propagates embedding backend 'input too large' errors from CLI for add command", async () => {
    const helper = await import("../helpers/mockCliSpawn.js");

    const stderrLines = [
      "[LLM] Attempt 3/3 to http://192.168.0.199:8000/v1/embeddings",
      "[LLM] HTTP 500 error from http://192.168.0.199:8000/v1/embeddings",
      "[LLM] Response body: {\"error\":{\"code\":500,\"message\":\"input (1169 tokens) is too large to process. increase the physical batch size (current batch size: 512)\"}}",
      "[LLM] Attempt 3 failed: LLM request failed with status 500: {\"error\":{\"code\":500,\"message\":\"input (1169 tokens) is too large to process. increase the physical batch size (current batch size: 512)\"}}",
    ];

    const { mockSpawn } = helper.createSpawnMockWithStderr(stderrLines, 2);
    await helper.doMockChildProcess(vi, mockSpawn);

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const gen = mod.runAddCommand("https://embed.example");
    let result: any;

    // iterate generator to completion to retrieve return value
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await gen.next();
      if (res.done) {
        result = res.value;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    // Ensure stderr/error contains the 'input too large' message
    expect(String(result.stderr || result.error)).toContain("input (1169 tokens) is too large");
  });

  it("propagates chat completion backend 'input too large' errors from CLI for summary command", async () => {
    const helper = await import("../helpers/mockCliSpawn.js");

    const stderrLines = [
      "[LLM] Attempt 2/2 to http://192.168.0.199:8000/v1/chat/completions",
      "[LLM] HTTP 500 error from http://192.168.0.199:8000/v1/chat/completions",
      "[LLM] Response body: {\"error\":{\"code\":500,\"message\":\"input (2048 tokens) is too large to process. increase the physical batch size (current batch size: 1024)\"}}",
    ];

    const { mockSpawn } = helper.createSpawnMockWithStderr(stderrLines, 3);
    await helper.doMockChildProcess(vi, mockSpawn);

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const result = await mod.runSummaryCommand("https://summary.example/item");
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(String(result.error || result.summary || result)).toContain("input (2048 tokens) is too large");
  });
});
