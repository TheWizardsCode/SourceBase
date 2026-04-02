import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll dynamically import the module after mocking child_process.spawn
// so that the module picks up our mocked implementation.
describe("runAddCommand spawn error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  afterEach(async () => {
    // Ensure any stray child processes are terminated
    const mod = await import("../../src/bot/cli-runner.js");
    await mod.terminateAllChildProcesses();
  });

  it("should throw CliRunnerError when spawn emits error with ENOENT", async () => {
    const helper = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn } = helper.createSpawnMockSpawnError("ENOENT");
    await helper.doMockChildProcess(vi, mockSpawn);

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    // runAddCommand returns an async generator; on spawn error the
    // underlying exitPromise will reject with CliRunnerError which should
    // be re-thrown by runAddCommand. We iterate the generator and assert
    // the thrown error is a CliRunnerError and contains an explanatory
    // message (including the ENOENT indicator) and the structured fields.
    const gen = mod.runAddCommand("https://x.example");

    try {
      await gen.next();
      throw new Error("Expected generator to reject with CliRunnerError");
    } catch (err: any) {
      // Validate error shape and content per acceptance criteria
      expect(err).toBeInstanceOf(mod.CliRunnerError);
      expect(err.name).toBe("CliRunnerError");
      // Message should mention spawn failure and ENOENT
      expect(err.message).toEqual(expect.stringContaining("Failed to spawn CLI"));
      expect(err.message).toEqual(expect.stringContaining("ENOENT"));
      // Exit code for spawn failure is set to -1
      expect(err.exitCode).toBe(-1);
      // Stderr should include the spawn error marker
      expect(err.stderr).toEqual(expect.stringContaining("[spawn error]"));
    }
  });
});
