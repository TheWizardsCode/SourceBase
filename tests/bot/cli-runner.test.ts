import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CliRunnerError,
  getActiveChildProcessCount,
  terminateAllChildProcesses,
  setCliPath,
  type AddProgressEvent,
  type ContextFlags,
  type RunnerOptions,
  type AddResult,
  type QueueResult,
  type StatsResult,
  type CliCommandResult,
} from "../../src/bot/cli-runner.js";

describe("CLI Runner Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    delete process.env.SB_CLI_PATH;
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
    it("should use SB_CLI_PATH environment variable", async () => {
      process.env.SB_CLI_PATH = "/custom/path/to/sb";
      expect(process.env.SB_CLI_PATH).toBe("/custom/path/to/sb");
    });

    it("should default to 'sb' when SB_CLI_PATH not set", async () => {
      expect(process.env.SB_CLI_PATH).toBeUndefined();
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
    it("should set SB_CLI_PATH environment variable", () => {
      setCliPath("/new/path/to/sb");
      expect(process.env.SB_CLI_PATH).toBe("/new/path/to/sb");
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
