import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager } from "../../src/lifecycle/LifecycleManager.js";

// Minimal fake logger
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

// Minimal fake client (not used by our tests but satisfies constructor)
const client = { channels: { fetch: async () => null } } as any;

describe("LifecycleManager shutdown integration", () => {
  let exitSpy: any;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      // Throw so we can stop execution without exiting the test runner
      throw new Error("process.exit:" + String(code));
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("invokes provided queuePresenter.clearAll() on shutdown", async () => {
    const called: string[] = [];
    const fakePresenter = {
      clearAll: async () => {
        called.push("clearAll");
      },
    };

    const lm = new LifecycleManager({ logger, client, queuePresenter: fakePresenter });

    // performGracefulShutdown will throw due to our process.exit stub; catch
    let threw = false;
    try {
      // @ts-ignore access private to avoid long-running timers in tests
      await lm.performGracefulShutdown("TEST");
    } catch (err: any) {
      threw = true;
      expect(String(err)).toContain("process.exit");
    }

    expect(threw).toBe(true);
    expect(called).toContain("clearAll");
  });

  it("invokes provided cleanupCallback on shutdown", async () => {
    const called: string[] = [];
    const cb = async () => {
      called.push("cb");
    };

    const lm = new LifecycleManager({ logger, client, cleanupCallback: cb });

    let threw = false;
    try {
      // @ts-ignore
      await lm.performGracefulShutdown("TEST");
    } catch (err: any) {
      threw = true;
      expect(String(err)).toContain("process.exit");
    }

    expect(threw).toBe(true);
    expect(called).toContain("cb");
  });
});
