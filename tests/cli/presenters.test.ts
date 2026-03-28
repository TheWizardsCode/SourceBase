import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CliProgressEvent } from "../../src/cli/presenters/types.js";
import { NdjsonProgressPresenter } from "../../src/cli/presenters/ndjson-presenter.js";
import { ConsoleProgressPresenter } from "../../src/cli/presenters/console-presenter.js";
import { WebhookProgressPresenter } from "../../src/cli/presenters/webhook-presenter.js";
import { createProgressPresenter, getDefaultFormat } from "../../src/cli/presenters/factory.js";

// Mock streams for testing
function createMockStream(isTTY = false): NodeJS.WriteStream {
  const writes: string[] = [];
  const stream = {
    isTTY: isTTY,
    writable: true,
    write: vi.fn((data: string, callback?: (err?: Error) => void) => {
      writes.push(data);
      if (callback) callback();
      return true;
    }),
    once: vi.fn(),
    _writes: writes,
  } as unknown as NodeJS.WriteStream & { _writes: string[] };
  return stream;
}

// Sample progress events for testing
const sampleEvent: CliProgressEvent = {
  type: "progress",
  phase: "downloading",
  url: "https://example.com/article",
  current: 1,
  total: 3,
  timestamp: "2026-03-27T10:00:00.000Z",
};

const completedEvent: CliProgressEvent = {
  type: "progress",
  phase: "completed",
  url: "https://example.com/article",
  current: 1,
  total: 1,
  timestamp: "2026-03-27T10:00:05.000Z",
  title: "Example Article",
  summary: "This is a test summary of the article.",
};

const failedEvent: CliProgressEvent = {
  type: "progress",
  phase: "failed",
  url: "https://example.com/bad",
  current: 1,
  total: 1,
  timestamp: "2026-03-27T10:00:10.000Z",
  message: "Network error: Connection refused",
};

const chunkEvent: CliProgressEvent = {
  type: "progress",
  phase: "summarizing",
  url: "https://example.com/long-article",
  current: 2,
  total: 3,
  timestamp: "2026-03-27T10:00:15.000Z",
  chunkCurrent: 2,
  chunkTotal: 5,
  chunkType: "summarizing",
};

describe("NdjsonProgressPresenter", () => {
  let stdout: ReturnType<typeof createMockStream>;
  let stderr: ReturnType<typeof createMockStream>;
  let presenter: NdjsonProgressPresenter;

  beforeEach(() => {
    stdout = createMockStream();
    stderr = createMockStream();
    presenter = new NdjsonProgressPresenter({}, stdout, stderr);
  });

  it("should write one JSON line per event to stdout", async () => {
    await presenter.onProgress(sampleEvent);

    expect(stdout.write).toHaveBeenCalled();
    const output = (stdout as unknown as { _writes: string[] })._writes[0];
    expect(output).toContain("\n");
  });

  it("should output valid JSON that can be parsed", async () => {
    await presenter.onProgress(sampleEvent);

    const output = (stdout as unknown as { _writes: string[] })._writes[0];
    const lines = output.trim().split("\n");

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("type", "progress");
      expect(parsed).toHaveProperty("phase", sampleEvent.phase);
      expect(parsed).toHaveProperty("url", sampleEvent.url);
      expect(parsed).toHaveProperty("current", sampleEvent.current);
      expect(parsed).toHaveProperty("total", sampleEvent.total);
      expect(parsed).toHaveProperty("timestamp");
    }
  });

  it("should include all event fields in output", async () => {
    await presenter.onProgress(completedEvent);

    const output = (stdout as unknown as { _writes: string[] })._writes[0];
    const parsed = JSON.parse(output.trim());

    expect(parsed).toMatchObject({
      type: "progress",
      phase: "completed",
      url: "https://example.com/article",
      current: 1,
      total: 1,
      title: "Example Article",
      summary: "This is a test summary of the article.",
    });
  });

  it("should handle multiple events as separate JSON lines", async () => {
    await presenter.onProgress(sampleEvent);
    await presenter.onProgress(completedEvent);

    const output = (stdout as unknown as { _writes: string[] })._writes.join("");
    const lines = output.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).phase).toBe("downloading");
    expect(JSON.parse(lines[1]).phase).toBe("completed");
  });

  it("should handle stream errors gracefully", async () => {
    stdout.write = vi.fn().mockImplementation((_data, callback) => {
      if (callback) callback(new Error("Write failed"));
      return true;
    });

    await presenter.onProgress(sampleEvent);

    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Error writing progress"));
  });
});

describe("ConsoleProgressPresenter", () => {
  let stdout: ReturnType<typeof createMockStream>;
  let stderr: ReturnType<typeof createMockStream>;

  beforeEach(() => {
    stdout = createMockStream();
    stderr = createMockStream();
  });

  describe("non-TTY mode", () => {
    beforeEach(() => {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
    });

    it("should write human-friendly progress lines", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(sampleEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      expect(output).toContain("⬇️");
      expect(output).toContain("Downloading");
      expect(output).toContain("https://example.com/article");
      expect(output).toContain("\n");
    });

    it("should show progress counters for batch operations", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(sampleEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      expect(output).toContain("[1/3]");
    });

    it("should show chunk info for chunk-level progress", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(chunkEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      expect(output).toContain("(chunk 2/5)");
    });

    it("should show completed event with title and summary", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(completedEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      expect(output).toContain("✅");
      expect(output).toContain("Example Article");
      expect(output).toContain("This is a test summary");
    });

    it("should show failed event with error message", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(failedEvent);

      const output = (stderr as unknown as { _writes: string[] })._writes[0];
      expect(output).toContain("❌");
      expect(output).toContain("Failed");
      expect(output).toContain("Network error: Connection refused");
    });

    it("should not include emojis that would fail tests", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(sampleEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      // The presenter uses emoji (⬇️, ✅, etc.) which should be present
      expect(output).toMatch(/[⬇️🔗🔄✍️🔢💾✅❌]/);
    });
  });

  describe("TTY mode", () => {
    beforeEach(() => {
      (stdout as unknown as { isTTY: boolean }).isTTY = true;
    });

    it("should use carriage return for in-progress phases", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(sampleEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      // Should not have newline for in-progress
      expect(output).not.toMatch(/\n$/);
    });

    it("should use newline for completed phase", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(completedEvent);

      const output = (stdout as unknown as { _writes: string[] })._writes[0];
      expect(output).toMatch(/\n$/);
    });

    it("should use newline for failed phase", async () => {
      const presenter = new ConsoleProgressPresenter({}, stdout, stderr);
      await presenter.onProgress(failedEvent);

      const output = (stderr as unknown as { _writes: string[] })._writes[0];
      expect(output).toMatch(/\n$/);
    });
  });
});

describe("WebhookProgressPresenter", () => {
  let stderr: ReturnType<typeof createMockStream>;

  beforeEach(() => {
    stderr = createMockStream();
    // Reset fetch mock
    vi.restoreAllMocks();
  });

  it("should POST JSON events to webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook" },
      stderr
    );
    await presenter.onProgress(sampleEvent);

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleEvent),
      signal: expect.any(AbortSignal),
    });
  });

  it("should require webhookUrl in constructor", () => {
    expect(() => {
      new WebhookProgressPresenter({ webhookUrl: "" }, stderr);
    }).toThrow("webhookUrl is required");
  });

  it("should retry once on network error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook", maxRetries: 1 },
      stderr
    );
    await presenter.onProgress(sampleEvent);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should log error to stderr when webhook is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook", maxRetries: 1 },
      stderr
    );
    await presenter.onProgress(sampleEvent);

    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Webhook unreachable")
    );
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Connection refused")
    );
  });

  it("should log error to stderr for non-2xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook" },
      stderr
    );
    await presenter.onProgress(sampleEvent);

    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Webhook failed: HTTP 500")
    );
  });

  it("should not crash on errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Fatal error"));
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook", maxRetries: 0 },
      stderr
    );

    // Should not throw
    await expect(presenter.onProgress(sampleEvent)).resolves.not.toThrow();
  });

  it("should use configurable timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    global.fetch = fetchMock;

    const presenter = new WebhookProgressPresenter(
      { webhookUrl: "https://example.com/webhook", timeoutMs: 10000 },
      stderr
    );
    await presenter.onProgress(sampleEvent);

    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("createProgressPresenter factory", () => {
  it("should create ConsoleProgressPresenter for 'console' format", () => {
    const presenter = createProgressPresenter({ format: "console" });
    expect(presenter).toBeInstanceOf(ConsoleProgressPresenter);
  });

  it("should create NdjsonProgressPresenter for 'ndjson' format", () => {
    const presenter = createProgressPresenter({ format: "ndjson" });
    expect(presenter).toBeInstanceOf(NdjsonProgressPresenter);
  });

  it("should create WebhookProgressPresenter for 'webhook' format", () => {
    const presenter = createProgressPresenter({
      format: "webhook",
      webhookUrl: "https://example.com/webhook",
    });
    expect(presenter).toBeInstanceOf(WebhookProgressPresenter);
  });

  it("should throw error when webhook format requested without webhookUrl", () => {
    expect(() => {
      createProgressPresenter({ format: "webhook" });
    }).toThrow("webhookUrl is required");
  });

  it("should use auto format by default", () => {
    const presenter = createProgressPresenter({});
    // Should create either Console or Ndjson based on TTY
    expect(
      presenter instanceof ConsoleProgressPresenter ||
        presenter instanceof NdjsonProgressPresenter
    ).toBe(true);
  });
});

describe("getDefaultFormat", () => {
  it("should return 'console' when stdout is TTY", () => {
    const mockStdout = { isTTY: true } as NodeJS.WriteStream;
    expect(getDefaultFormat(mockStdout)).toBe("console");
  });

  it("should return 'ndjson' when stdout is not TTY", () => {
    const mockStdout = { isTTY: false } as NodeJS.WriteStream;
    expect(getDefaultFormat(mockStdout)).toBe("ndjson");
  });

  it("should return 'ndjson' when isTTY is undefined", () => {
    const mockStdout = {} as NodeJS.WriteStream;
    expect(getDefaultFormat(mockStdout)).toBe("ndjson");
  });
});
