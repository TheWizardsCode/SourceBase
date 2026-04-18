import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

  it("truncates large stats output for Discord and logs full output (non-test env)", async () => {
    // Simulate very large CLI output
    const largeOutput = "A".repeat(5000);
    const runStatsMock = vi.fn(async () => ({ raw: largeOutput }));

    const handler = new StatsCommandHandler({
      runStats: runStatsMock as any,
    });

    const interaction: any = {
      commandName: "stats",
      id: "interaction-3",
      channelId: "channel-3",
      user: { id: "user-3" },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    // Temporarily set NODE_ENV to a non-test value to exercise truncation
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined as any);

    const handled = await handler.handleCommand(interaction);

    // Restore NODE_ENV
    process.env.NODE_ENV = prevEnv;

    expect(handled).toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(runStatsMock).toHaveBeenCalled();

    // Ensure the bot replied with a truncated code block and a footer
    expect(interaction.editReply).toHaveBeenCalled();
    const replyArg = (interaction.editReply as any).mock.calls[0][0] as string;
    expect(replyArg.includes("...(truncated)") || replyArg.includes("... (truncated)")).toBeTruthy();
    expect(replyArg.includes("Truncated output - see bot logs") || replyArg.includes("Truncated output - see bot logs or run `ob stats` locally for full output")).toBeTruthy();

    // Full output should have been logged
    expect(consoleInfo).toHaveBeenCalled();
    // The second console.info call should include the full raw output
    const logged = consoleInfo.mock.calls.map((c) => String(c[0]));
    expect(logged.some((s) => s.includes("stats output truncated"))).toBeTruthy();
    expect(logged.some((s) => s === largeOutput)).toBeTruthy();

    consoleInfo.mockRestore();
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
