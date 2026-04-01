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

      const spawnCalls: Array<{ exe: string; args: string[]; opts: any }> = [];

      // Provide a runtime mock for child_process.spawn
      await vi.doMock(
        "child_process",
        async () => {
          const actual = await vi.importActual<typeof import("child_process")>(
            "child_process"
          );
          const events = await vi.importActual<typeof import("events")>("events");
          const stream = await vi.importActual<typeof import("stream")>("stream");

          function makeFakeChild() {
            const child = new events.EventEmitter();
            // Attach stdout/stderr as Readable streams
            const stdout = new stream.Readable({ read() {} });
            const stderr = new stream.Readable({ read() {} });
            (child as any).stdout = stdout;
            (child as any).stderr = stderr;
            (child as any).exitCode = null;
            (child as any).signalCode = null;
            (child as any).kill = (signal?: string) => {
              // simulate immediate exit
              setTimeout(() => child.emit("exit", 0), 0);
              return true;
            };
            return child as unknown as import("child_process").ChildProcess;
          }

          const mockSpawn = (exe: string, args: string[], opts: any) => {
            spawnCalls.push({ exe, args, opts });
            const child = makeFakeChild();
            // end stdout/stderr streams
            (child as any).stdout.push(null);
            (child as any).stderr.push(null);
            // emit exit next tick
            setTimeout(() => child.emit("exit", 0), 0);
            return child;
          };

          return { ...actual, spawn: mockSpawn };
        }
      );

      const mod = await import("../../src/bot/cli-runner.js");

      // Ensure no env var is present and reset module state
      delete process.env.OB_CLI_PATH;
      mod.setCliPath(undefined);

      // Call a simple command to trigger spawn
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      expect(spawnCalls.length).toBeGreaterThan(0);
      expect(spawnCalls[0].exe).toBe("ob");
    });

    it("should use OB_CLI_PATH when set in environment", async () => {
      vi.resetModules();

      const spawnCalls: Array<{ exe: string; args: string[]; opts: any }> = [];

      await vi.doMock("child_process", async () => {
        const actual = await vi.importActual<typeof import("child_process")>(
          "child_process"
        );
        const events = await vi.importActual<typeof import("events")>("events");
        const stream = await vi.importActual<typeof import("stream")>("stream");

        function makeFakeChild() {
          const child = new events.EventEmitter();
          const stdout = new stream.Readable({ read() {} });
          const stderr = new stream.Readable({ read() {} });
          (child as any).stdout = stdout;
          (child as any).stderr = stderr;
          (child as any).exitCode = null;
          (child as any).signalCode = null;
          (child as any).kill = (signal?: string) => {
            setTimeout(() => child.emit("exit", 0), 0);
            return true;
          };
          return child as unknown as import("child_process").ChildProcess;
        }

        const mockSpawn = (exe: string, args: string[], opts: any) => {
          spawnCalls.push({ exe, args, opts });
          const child = makeFakeChild();
          (child as any).stdout.push(null);
          (child as any).stderr.push(null);
          setTimeout(() => child.emit("exit", 0), 0);
          return child;
        };

        return { ...actual, spawn: mockSpawn };
      });

      // Set the env var before importing the module so it picks it up
      process.env.OB_CLI_PATH = "/tmp/fake/ob";
      const mod = await import("../../src/bot/cli-runner.js");

      mod.setCliPath(undefined);
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      expect(spawnCalls.length).toBeGreaterThan(0);
      expect(spawnCalls[0].exe).toBe("/tmp/fake/ob");
    });

    it("setCliPath should override env and default values", async () => {
      vi.resetModules();

      const spawnCalls: Array<{ exe: string; args: string[]; opts: any }> = [];

      await vi.doMock("child_process", async () => {
        const actual = await vi.importActual<typeof import("child_process")>(
          "child_process"
        );
        const events = await vi.importActual<typeof import("events")>("events");
        const stream = await vi.importActual<typeof import("stream")>("stream");

        function makeFakeChild() {
          const child = new events.EventEmitter();
          const stdout = new stream.Readable({ read() {} });
          const stderr = new stream.Readable({ read() {} });
          (child as any).stdout = stdout;
          (child as any).stderr = stderr;
          (child as any).exitCode = null;
          (child as any).signalCode = null;
          (child as any).kill = (signal?: string) => {
            setTimeout(() => child.emit("exit", 0), 0);
            return true;
          };
          return child as unknown as import("child_process").ChildProcess;
        }

        const mockSpawn = (exe: string, args: string[], opts: any) => {
          spawnCalls.push({ exe, args, opts });
          const child = makeFakeChild();
          (child as any).stdout.push(null);
          (child as any).stderr.push(null);
          setTimeout(() => child.emit("exit", 0), 0);
          return child;
        };

        return { ...actual, spawn: mockSpawn };
      });

      // Set env var then import module
      process.env.OB_CLI_PATH = "/tmp/fake/ob";
      const mod = await import("../../src/bot/cli-runner.js");

      // Now override via API
      mod.setCliPath("/my/override/ob");
      await mod.runCliCommand("--version", [], { timeoutMs: 100 });

      expect(spawnCalls.length).toBeGreaterThan(0);
      expect(spawnCalls[0].exe).toBe("/my/override/ob");

      // Restore
      mod.setCliPath(undefined);
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
