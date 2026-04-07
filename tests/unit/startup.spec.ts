import { describe, expect, it, vi } from "vitest";
import { startBot } from "../../src/lifecycle/startup.js";

describe("startBot", () => {
  it("starts successfully and logs startup", async () => {
    const start = vi.fn(async () => undefined);
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as any;

    await startBot(start, logger);

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Bot started successfully");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs startup failures and sets process exit code", async () => {
    const start = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as any;

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    await startBot(start, logger);

    expect(logger.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = previousExitCode;
  });
});
