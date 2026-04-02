import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("runAddCommand timeout handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import("../../src/bot/cli-runner.js");
    await mod.terminateAllChildProcesses();
  });

  it("should reject with CliRunnerError when subprocess exceeds timeout and kill is invoked", async () => {
    const helper = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn, spawnCalls } = helper.createSpawnMockLongRunning(0);
    await helper.doMockChildProcess(vi, mockSpawn);

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    // use a very small timeout so the timer triggers promptly
    const gen = mod.runAddCommand("https://timeout.example", { timeoutMs: 5 });

    try {
      await gen.next();
      throw new Error("Expected generator to reject due to timeout");
    } catch (err: any) {
      expect(err).toBeInstanceOf(mod.CliRunnerError);
      expect(err.message).toEqual(expect.stringContaining("timed out"));
      expect(err.exitCode).toBe(-1);
      // Ensure the mocked child was sent kill (our mock sets __killed)
      // spawnCalls holds the recorded calls; the child is attached there.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recorded = (spawnCalls as any)[0];
      expect(recorded).toBeDefined();
      expect(recorded.child).toBeDefined();
      expect(recorded.child.__killed).toBe(true);
    }
  });
});
