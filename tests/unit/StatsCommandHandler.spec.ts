import { describe, expect, it, vi } from "vitest";
import { StatsCommandHandler } from "../../src/handlers/StatsCommandHandler.js";

describe("StatsCommandHandler", () => {
  it("handles /stats and replies with unavailable message", async () => {
    const handler = new StatsCommandHandler();
    const interaction: any = {
      commandName: "stats",
      reply: vi.fn(async () => undefined),
    };

    const handled = await handler.handleCommand(interaction);

    expect(handled).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(
      "Stats functionality temporarily unavailable - CLI has been extracted to openBrain repository."
    );
  });

  it("returns false for non-stats command", async () => {
    const handler = new StatsCommandHandler();
    const interaction: any = {
      commandName: "search",
      reply: vi.fn(async () => undefined),
    };

    const handled = await handler.handleCommand(interaction);

    expect(handled).toBe(false);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
