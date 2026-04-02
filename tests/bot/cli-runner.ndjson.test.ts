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
    const helper = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn } = helper.createSpawnMockNdjson([
      { phase: "downloading", url: "https://x.example" },
      { phase: "completed", url: "https://x.example", title: "Page Title" },
    ]);
    await helper.doMockChildProcess(vi, mockSpawn);

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
    const helper2 = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn: mockSpawn2 } = helper2.createSpawnMockInvalidThenValid("not-json-line", {
      phase: "completed",
      url: "https://x.example",
      title: "Good",
    });
    await helper2.doMockChildProcess(vi, mockSpawn2);

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
    const helper3 = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn: mockSpawn3 } = helper3.createSpawnMockNdjson([
      { phase: "downloading", url: "https://x.example" },
      { phase: "failed", url: "https://x.example", message: "Not found" },
    ]);
    await helper3.doMockChildProcess(vi, mockSpawn3);

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
    const helper4 = await import("../helpers/mockCliSpawn.js");
    const { mockSpawn: mockSpawn4 } = helper4.createSpawnMockWithStderr(["simulated error output"], 2);
    await helper4.doMockChildProcess(vi, mockSpawn4);

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
