import { describe, expect, it, vi } from "vitest";
import { StatsCommandHandler } from "../../src/handlers/StatsCommandHandler.js";

describe("StatsCommandHandler", () => {
  it("handles /stats by querying stats and editing the deferred reply", async () => {
    const runStatsMock = vi.fn(async () => ({
      raw: "Total links: 100\nProcessed: 80 (80.0%)\nPending: 15\nFailed: 5 (5.0%)",
    }));

    const handler = new StatsCommandHandler({
      runStats: runStatsMock as any,
    });

    const interaction: any = {
      commandName: "stats",
      id: "interaction-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    const handled = await handler.handleCommand(interaction);

    expect(handled).toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(runStatsMock).toHaveBeenCalledWith({
      channelId: "channel-1",
      messageId: "interaction-1",
      authorId: "user-1",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "```markdown\nTotal links: 100\nProcessed: 80 (80.0%)\nPending: 15\nFailed: 5 (5.0%)\n```"
    );
  });

  it("replies with an error message when stats query fails", async () => {
    const runStatsMock = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    const handler = new StatsCommandHandler({
      runStats: runStatsMock as any,
    });

    const interaction: any = {
      commandName: "stats",
      id: "interaction-2",
      channelId: "channel-2",
      user: { id: "user-2" },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    const handled = await handler.handleCommand(interaction);

    expect(handled).toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      "❌ Failed to retrieve OpenBrain statistics. Please try again."
    );
  });

  it("returns false for non-stats command", async () => {
    const runStatsMock = vi.fn(async () => ({
      raw: "Total links: 1\nProcessed: 1 (100.0%)\nPending: 0\nFailed: 0",
    }));

    const handler = new StatsCommandHandler({
      runStats: runStatsMock as any,
    });

    const interaction: any = {
      commandName: "search",
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    const handled = await handler.handleCommand(interaction);

    expect(handled).toBe(false);
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(runStatsMock).not.toHaveBeenCalled();
  });
});
