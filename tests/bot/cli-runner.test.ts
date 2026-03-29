import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CliRunnerError,
  setCliPath,
  type CliContext,
  type CliRunnerOptions,
  type QueueResult,
  type AddResult,
  type StatsResult,
} from "../../src/bot/cli-runner.js";

describe("CLI Runner Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("exports", () => {
    it("should export CliRunnerError class", () => {
      expect(typeof CliRunnerError).toBe("function");
    });

    it("should export setCliPath function", () => {
      expect(typeof setCliPath).toBe("function");
    });
  });

  describe("CliRunnerError", () => {
    it("should capture exit code and stderr", () => {
      const error = new CliRunnerError("Test error", 1, "stderr content");
      expect(error.message).toBe("Test error");
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toBe("stderr content");
      expect(error.name).toBe("CliRunnerError");
    });

    it("should be instance of Error", () => {
      const error = new CliRunnerError("Test", 0, "");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("setCliPath", () => {
    it("should set SB_CLI_PATH environment variable", () => {
      const originalPath = process.env.SB_CLI_PATH;

      setCliPath("/custom/path/to/sb");

      expect(process.env.SB_CLI_PATH).toBe("/custom/path/to/sb");

      // Restore original
      if (originalPath) {
        process.env.SB_CLI_PATH = originalPath;
      } else {
        delete process.env.SB_CLI_PATH;
      }
    });
  });

  describe("type exports", () => {
    it("should have CliContext type (compile-time check)", () => {
      const context: CliContext = {
        channelId: "123",
        messageId: "456",
        authorId: "789",
      };
      expect(context.channelId).toBe("123");
    });

    it("should have CliRunnerOptions type (compile-time check)", () => {
      const options: CliRunnerOptions = {
        channelId: "123",
        timeoutMs: 5000,
        cwd: "/tmp",
      };
      expect(options.timeoutMs).toBe(5000);
    });

    it("should have QueueResult type (compile-time check)", () => {
      const result: QueueResult = {
        success: true,
        url: "https://example.com",
        id: 123,
      };
      expect(result.success).toBe(true);
    });

    it("should have AddResult type (compile-time check)", () => {
      const result: AddResult = {
        success: true,
        url: "https://example.com",
        title: "Example",
        id: 456,
      };
      expect(result.title).toBe("Example");
    });

    it("should have StatsResult type (compile-time check)", () => {
      const stats: StatsResult = {
        totalLinks: 100,
        linksWithEmbeddings: 95,
        linksWithSummaries: 90,
        linksWithContent: 98,
        linksWithTranscripts: 5,
        linksLast24Hours: 10,
        linksLast7Days: 50,
        linksLast30Days: 80,
      };
      expect(stats.totalLinks).toBe(100);
    });
  });
});
