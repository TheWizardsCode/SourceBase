import { describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger.js";

describe("Logger", () => {
  it("logs info records when level is info", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const logger = new Logger("info");
    logger.info("hello", { key: "value" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({
        level: "info",
        message: "hello",
        meta: { key: "value" }
      })
    );

    spy.mockRestore();
  });

  it("does not log debug records when level is warn", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const logger = new Logger("warn");
    logger.debug("hidden");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
