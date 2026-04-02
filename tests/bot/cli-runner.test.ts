import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AddProgressEvent,
  ContextFlags,
  RunnerOptions,
  AddResult,
  QueueResult,
  StatsResult,
  CliCommandResult,
} from "../../src/bot/cli-runner.js";
// Runtime imports for functions used by existing tests (these do not rely on mocking)
import {
  CliRunnerError,
  getActiveChildProcessCount,
  terminateAllChildProcesses,
  setCliPath,
} from "../../src/bot/cli-runner.js";

describe("CLI Runner Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    delete process.env.OB_CLI_PATH;
  });

  afterEach(async () => {
    // Clean up any active processes
    await terminateAllChildProcesses();
  });

  describe("Module Exports", () => {
    it("should export CliRunnerError class", () => {
      expect(typeof CliRunnerError).toBe("function");
      const error = new CliRunnerError("test message", 1, "stderr");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CliRunnerError);
      expect(error.message).toBe("test message");
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toBe("stderr");
      expect(error.name).toBe("CliRunnerError");
    });
  });

  describe("Type Definitions", () => {
    it("should have correct AddProgressEvent structure", () => {
      const event: AddProgressEvent = {
        phase: "downloading",
        url: "https://example.com",
        message: "test",
        title: "Test Title",
      };
      expect(event.phase).toBe("downloading");
      expect(event.url).toBe("https://example.com");
    });

    it("should have correct ContextFlags structure", () => {
      const flags: ContextFlags = {
        channelId: "123",
        messageId: "456",
        authorId: "789",
      };
      expect(flags.channelId).toBe("123");
      expect(flags.messageId).toBe("456");
      expect(flags.authorId).toBe("789");
    });

    it("should have correct RunnerOptions structure", () => {
      const options: RunnerOptions = {
        channelId: "123",
        messageId: "456",
        authorId: "789",
        cwd: "/tmp",
        env: { KEY: "value" },
        timeoutMs: 10000,
      };
      expect(options.timeoutMs).toBe(10000);
      expect(options.cwd).toBe("/tmp");
    });

    it("should have correct AddResult structure", () => {
      const result: AddResult = {
        success: true,
        url: "https://example.com",
        title: "Test",
      };
      expect(result.success).toBe(true);
      expect(result.title).toBe("Test");
    });

    it("should have correct QueueResult structure", () => {
      const result: QueueResult = {
        success: true,
        url: "https://example.com",
        id: 123,
      };
      expect(result.success).toBe(true);
      expect(result.id).toBe(123);
    });

    it("should have correct StatsResult structure", () => {
      const result: StatsResult = {
        totalLinks: 100,
        processedCount: 80,
        pendingCount: 15,
        failedCount: 5,
      };
      expect(result.totalLinks).toBe(100);
      expect(result.processedCount).toBe(80);
    });

    it("should have correct CliCommandResult structure", () => {
      const result: CliCommandResult = {
        stdout: ["line1", "line2"],
        stderr: "error",
        exitCode: 0,
      };
      expect(result.stdout).toHaveLength(2);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Environment Configuration", () => {
    it("should default to 'ob' when no CLI env var is set", async () => {
      // The runner now uses the globally-installed 'ob' by default.
      delete process.env.OB_CLI_PATH;
      expect(process.env.OB_CLI_PATH).toBeUndefined();
    });

    // Tests that require mocking child_process.spawn must import the module
    // after stubbing the spawn implementation. We dynamically import the
    // module in each test and use vi.doMock to replace child_process.spawn.
    it("should spawn the default 'ob' executable when no env or API override is set", async () => {
      // isolate module cache
      vi.resetModules();

      // Use shared helper to mock child_process.spawn
      const helper = await import("../helpers/mockCliSpawn.js");
      const { mockSpawn, spawnCalls } = helper.createSpawnMockSimple();
      (global as any).spawnCalls = spawnCalls;
      await helper.doMockChildProcess(vi, mockSpawn);

      const mod = await import("../../src/bot/cli-runner.js");

      // Ensure no env var is present and reset module state
      delete process.env.OB_CLI_PATH;
      mod.setCliPath(undefined);

      // Call a simple command to trigger spawn
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      // spawnCalls is provided by the helper as a captured array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalSpawnCalls = (global as any).spawnCalls as Array<{ exe: string; args: string[]; opts: any }>;
      expect(globalSpawnCalls.length).toBeGreaterThan(0);
      expect(globalSpawnCalls[0].exe).toBe("ob");
    });

    it("should use OB_CLI_PATH when set in environment", async () => {
      vi.resetModules();

      const spawnCalls: Array<{ exe: string; args: string[]; opts: any }> = [];

      const helper = await import("../helpers/mockCliSpawn.js");
      const { mockSpawn, spawnCalls: spawnCallsLocal } = helper.createSpawnMockSimple();
      // expose spawnCalls to the test scope
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).spawnCalls = spawnCallsLocal;
      await helper.doMockChildProcess(vi, mockSpawn);

      // Set the env var before importing the module so it picks it up
      process.env.OB_CLI_PATH = "/tmp/fake/ob";
      const mod = await import("../../src/bot/cli-runner.js");

      mod.setCliPath(undefined);
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalSpawnCalls2 = (global as any).spawnCalls as Array<{ exe: string; args: string[]; opts: any }>;
      expect(globalSpawnCalls2.length).toBeGreaterThan(0);
      expect(globalSpawnCalls2[0].exe).toBe("/tmp/fake/ob");
    });

    it("setCliPath should override env and default values", async () => {
      vi.resetModules();

      const spawnCalls: Array<{ exe: string; args: string[]; opts: any }> = [];

      const helper2 = await import("../helpers/mockCliSpawn.js");
      const { mockSpawn: mockSpawn2, spawnCalls: spawnCallsLocal2 } = helper2.createSpawnMockSimple();
      (global as any).spawnCalls = spawnCallsLocal2;
      await helper2.doMockChildProcess(vi, mockSpawn2);

      // Set env var then import module
      process.env.OB_CLI_PATH = "/tmp/fake/ob";
      const mod = await import("../../src/bot/cli-runner.js");

      // Now override via API
      mod.setCliPath("/my/override/ob");
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalSpawnCalls3 = (global as any).spawnCalls as Array<{ exe: string; args: string[]; opts: any }>;
      expect(globalSpawnCalls3.length).toBeGreaterThan(0);
      expect(globalSpawnCalls3[0].exe).toBe("/my/override/ob");

      // Restore
      mod.setCliPath(undefined);
    });
  });

  describe("runSummaryCommand", () => {
    it("returns summary text from stdout when command succeeds", async () => {
      vi.resetModules();

      const helper = await import("../helpers/mockCliSpawn.js");
      const { mockSpawn, spawnCalls } = helper.createSpawnMockSummary([
        "This is a generated summary.",
        "Second line.",
      ]);
      await helper.doMockChildProcess(vi, mockSpawn);

      const mod = await import("../../src/bot/cli-runner.js");
      mod.setCliPath(undefined);

      const result = await mod.runSummaryCommand("https://summary.example/item", {
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "author-1",
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("https://summary.example/item");
      expect(result.summary).toBe("This is a generated summary.\nSecond line.");

      const summaryCall = spawnCalls.find((call: { args: string[] }) => call.args[0] === "summary");
      expect(summaryCall).toBeDefined();

      // summary only accepts a URL argument; context metadata is reserved for add/queue
      expect(summaryCall!.args).not.toContain("--tag");
      expect(summaryCall!.args).toContain("https://summary.example/item");
    });

    it("returns failure when summary command exits non-zero", async () => {
      vi.resetModules();

      const helper = await import("../helpers/mockCliSpawn.js");
      const { mockSpawn } = helper.createSpawnMockWithStderr(["summary failed"], 1);
      await helper.doMockChildProcess(vi, mockSpawn);

      const mod = await import("../../src/bot/cli-runner.js");
      mod.setCliPath(undefined);

      const result = await mod.runSummaryCommand("https://summary.example/fail");

      expect(result.success).toBe(false);
      expect(result.error).toContain("summary failed");
    });
  });

  describe("Process Management", () => {
    it("should return 0 for active child process count initially", () => {
      expect(getActiveChildProcessCount()).toBe(0);
    });

    it("should terminate all child processes gracefully without error", async () => {
      // Should not throw when no processes active
      await expect(terminateAllChildProcesses()).resolves.not.toThrow();
    });
  });

  describe("setCliPath", () => {
    it("setCliPath is a no-op warning", () => {
      // Function intentionally no longer mutates environment; it should not throw
      setCliPath("/new/path/to/sb");
      expect(process.env.SB_CLI_PATH).toBeUndefined();
    });
  });

  describe("CliRunnerError", () => {
    it("should capture exit code and stderr", () => {
      const error = new CliRunnerError("Command failed", 1, "error output");
      expect(error.message).toBe("Command failed");
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toBe("error output");
    });

    it("should work with try/catch", () => {
      try {
        throw new CliRunnerError("Test error", 2, "stderr");
      } catch (error) {
        expect(error).toBeInstanceOf(CliRunnerError);
        expect(error).toBeInstanceOf(Error);
        if (error instanceof CliRunnerError) {
          expect(error.exitCode).toBe(2);
          expect(error.stderr).toBe("stderr");
        }
      }
    });
  });
});
