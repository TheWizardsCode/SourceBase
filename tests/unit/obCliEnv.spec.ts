import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSpawnMockSimple, doMockChildProcess } from "../helpers/mockCliSpawn.js";
import { withObCliPath, setObCliPath } from "../helpers/obCliEnv.js";

describe("obCliEnv test helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure tests don't leak OB_CLI_PATH
    delete process.env.OB_CLI_PATH;
  });

  it("setObCliPath returns restore function and updates process.env", () => {
    const restore = setObCliPath("/tmp/fake/ob");
    expect(process.env.OB_CLI_PATH).toBe("/tmp/fake/ob");
    restore();
    expect(process.env.OB_CLI_PATH).toBeUndefined();
  });

  it("withObCliPath restores env after success", async () => {
    expect(process.env.OB_CLI_PATH).toBeUndefined();
    await withObCliPath("/tmp/ob1", async () => {
      expect(process.env.OB_CLI_PATH).toBe("/tmp/ob1");
    });
    expect(process.env.OB_CLI_PATH).toBeUndefined();
  });

  it("withObCliPath restores env after thrown error", async () => {
    expect(process.env.OB_CLI_PATH).toBeUndefined();
    let thrown = false;
    try {
      await withObCliPath("/tmp/ob2", async () => {
        expect(process.env.OB_CLI_PATH).toBe("/tmp/ob2");
        throw new Error("simulated");
      });
    } catch (e) {
      thrown = true;
    }
    expect(thrown).toBe(true);
    expect(process.env.OB_CLI_PATH).toBeUndefined();
  });

  it("withObCliPath attempts to update cli-runner internal state when loaded", async () => {
    // Mock child_process.spawn to avoid real subprocesses if cli-runner is imported.
    const { mockSpawn } = createSpawnMockSimple();
    await doMockChildProcess(vi, mockSpawn);

    // Import cli-runner to ensure getCliPath/setCliPath exist
    const mod = await import("../../src/bot/cli-runner.js");
    const before = mod.getCliPath();

    await withObCliPath("/tmp/shim/ob", async () => {
      expect(process.env.OB_CLI_PATH).toBe("/tmp/shim/ob");
      // internal cli path should reflect env (best-effort)
      const current = mod.getCliPath();
      expect(typeof current).toBe("string");
    });

    // restore should have returned internal path to previous value
    const after = mod.getCliPath();
    expect(after).toBe(before);
  });
});
