import { describe, expect, it, vi } from "vitest";
import { createShutdownController } from "../../src/lifecycle/shutdown.js";

describe("createShutdownController", () => {
  it("registers SIGTERM and SIGINT handlers", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as any;

    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process as any);

    const controller = createShutdownController(logger);

    expect(controller.isShuttingDown()).toBe(false);
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    onSpy.mockRestore();
  });
});
