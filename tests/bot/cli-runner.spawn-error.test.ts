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
    await vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
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
        const child = makeFakeChild();

        // Emit error asynchronously to simulate spawn failing. Also end
        // stdout/stderr so the stdout iterator can complete and the
        // generator will observe the rejected exitPromise.
        setTimeout(() => {
          const err: NodeJS.ErrnoException = new Error("spawn ENOENT");
          err.code = "ENOENT";
          (child as any).emit("error", err);
          // Close streams so readline completes
          try {
            (child as any).stdout.push(null);
            (child as any).stderr.push(null);
          } catch {}
        }, 0);

        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    // runAddCommand returns an async generator, but on spawn error the
    // underlying exitPromise will reject with CliRunnerError which should
    // be re-thrown by runAddCommand. We therefore attempt to iterate the
    // generator and expect a thrown CliRunnerError.
    const gen = mod.runAddCommand("https://x.example");

    // advancing the generator will eventually cause the spawn error to
    // be observed when the generator awaits the exitPromise. Use next()
    // and assert it rejects with CliRunnerError.
    await expect(gen.next()).rejects.toMatchObject({ name: "CliRunnerError" });
  });
});
