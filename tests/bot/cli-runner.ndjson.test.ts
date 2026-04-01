import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddProgressEvent, AddResult } from "../../src/bot/cli-runner.js";

describe("runAddCommand NDJSON parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  afterEach(async () => {
    // Ensure any stray child processes are terminated when tests finish
    const mod = await import("../../src/bot/cli-runner.js");
    await mod.terminateAllChildProcesses();
  });

  it("parses NDJSON progress events and returns success when completed", async () => {
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
          // simulate immediate exit
          setTimeout(() => child.emit("exit", 0), 0);
          return true;
        };
        return child as unknown as import("child_process").ChildProcess;
      }

      const mockSpawn = (exe: string, args: string[], opts: any) => {
        const child = makeFakeChild();

        // Emit NDJSON lines on stdout, then end and exit
        setTimeout(() => {
          (child as any).stdout.push(
            JSON.stringify({ phase: "downloading", url: "https://x.example" }) + "\n"
          );
          (child as any).stdout.push(
            JSON.stringify({ phase: "completed", url: "https://x.example", title: "Page Title" }) + "\n"
          );
          (child as any).stdout.push(null);
          setTimeout(() => child.emit("exit", 0), 0);
        }, 0);

        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const gen = mod.runAddCommand("https://x.example");
    const events: AddProgressEvent[] = [];
    let result: AddResult | undefined;

    // Iterate explicitly to capture the generator return value
    // (res.done === true).for-await would discard the return value.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await gen.next();
      if (res.done) {
        result = res.value as AddResult;
        break;
      }
      events.push(res.value as AddProgressEvent);
    }

    expect(events.length).toBe(2);
    expect(events[0].phase).toBe("downloading");
    expect(events[1].phase).toBe("completed");
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect(result!.title).toBe("Page Title");
  });

  it("ignores invalid NDJSON lines and still returns result", async () => {
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
        const child = makeFakeChild();
        setTimeout(() => {
          (child as any).stdout.push("not-json-line\n");
          (child as any).stdout.push(
            JSON.stringify({ phase: "completed", url: "https://x.example", title: "Good" }) + "\n"
          );
          (child as any).stdout.push(null);
          setTimeout(() => child.emit("exit", 0), 0);
        }, 0);
        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const gen = mod.runAddCommand("https://x.example");
    const events: AddProgressEvent[] = [];
    let result: AddResult | undefined;

    // capture events and return value
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await gen.next();
      if (res.done) {
        result = res.value as AddResult;
        break;
      }
      events.push(res.value as AddProgressEvent);
    }

    // invalid line should be ignored; only one valid event expected
    expect(events.length).toBe(1);
    expect(events[0].phase).toBe("completed");
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect(result!.title).toBe("Good");
  });

  it("returns failure when last event indicates failed phase", async () => {
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
        const child = makeFakeChild();
        setTimeout(() => {
          (child as any).stdout.push(
            JSON.stringify({ phase: "downloading", url: "https://x.example" }) + "\n"
          );
          (child as any).stdout.push(
            JSON.stringify({ phase: "failed", url: "https://x.example", message: "Not found" }) + "\n"
          );
          (child as any).stdout.push(null);
          setTimeout(() => child.emit("exit", 0), 0);
        }, 0);
        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const gen = mod.runAddCommand("https://x.example");
    const events: AddProgressEvent[] = [];
    let result: AddResult | undefined;

    // capture events and return value
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await gen.next();
      if (res.done) {
        result = res.value as AddResult;
        break;
      }
      events.push(res.value as AddProgressEvent);
    }

    expect(events.length).toBe(2);
    expect(events[1].phase).toBe("failed");
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("Not found");
  });

  it("returns failure and includes stderr when CLI exits non-zero", async () => {
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
          setTimeout(() => child.emit("exit", 2), 0);
          return true;
        };
        return child as unknown as import("child_process").ChildProcess;
      }

      const mockSpawn = (exe: string, args: string[], opts: any) => {
        const child = makeFakeChild();
        setTimeout(() => {
          // emit some stderr data
          (child as any).stderr.push("simulated error output\n");
          (child as any).stderr.push(null);
          (child as any).stdout.push(null);
          setTimeout(() => child.emit("exit", 2), 0);
        }, 0);
        return child;
      };

      return { ...actual, spawn: mockSpawn };
    });

    const mod = await import("../../src/bot/cli-runner.js");
    mod.setCliPath(undefined);

    const gen = mod.runAddCommand("https://x.example");
    let result: AddResult | undefined;

    // no stdout events expected; capture return value
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await gen.next();
      if (res.done) {
        result = res.value as AddResult;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("simulated error output");
  });
});
