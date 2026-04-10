import { describe, it, expect, beforeEach } from "vitest";
import QueuePresenter from "../../src/presenters/QueuePresenter.js";

describe("QueuePresenter.formatQueueStatusMessage", () => {
  let qp: QueuePresenter;

  beforeEach(() => {
    qp = new QueuePresenter();
  });

  it("returns default message when no params provided", () => {
    const result = qp.formatQueueStatusMessage({});
    expect(result).toBe("Queue status");
  });

  it("formats processing status", () => {
    const result = qp.formatQueueStatusMessage({ processing: true });
    expect(result).toBe("🔄 Processing");
  });

  it("formats position only", () => {
    const result = qp.formatQueueStatusMessage({ position: 5 });
    expect(result).toBe("Position 5");
  });

  it("formats position with total", () => {
    const result = qp.formatQueueStatusMessage({ position: 3, total: 10 });
    expect(result).toBe("Position 3/10");
  });

  it("formats URL", () => {
    const result = qp.formatQueueStatusMessage({ url: "https://example.com" });
    expect(result).toBe("URL: <https://example.com>");
  });

  it("formats note", () => {
    const result = qp.formatQueueStatusMessage({ note: "Custom note here" });
    expect(result).toBe("Custom note here");
  });

  it("formats processing with position", () => {
    const result = qp.formatQueueStatusMessage({ processing: true, position: 2 });
    expect(result).toBe("🔄 Processing — Position 2");
  });

  it("formats processing with position and total", () => {
    const result = qp.formatQueueStatusMessage({ processing: true, position: 2, total: 5 });
    expect(result).toBe("🔄 Processing — Position 2/5");
  });

  it("formats all params together", () => {
    const result = qp.formatQueueStatusMessage({
      processing: true,
      position: 1,
      total: 3,
      url: "https://example.com/page",
      note: "Almost done"
    });
    expect(result).toBe("🔄 Processing — Position 1/3 — URL: <https://example.com/page> — Almost done");
  });

  it("handles zero position correctly", () => {
    const result = qp.formatQueueStatusMessage({ position: 0, total: 5 });
    expect(result).toBe("Position 0/5");
  });

  it("handles position zero without total", () => {
    const result = qp.formatQueueStatusMessage({ position: 0 });
    expect(result).toBe("Position 0");
  });

  it("ignores undefined optional params", () => {
    const result = qp.formatQueueStatusMessage({
      processing: true,
      position: undefined,
      total: undefined,
      url: undefined,
      note: undefined
    });
    expect(result).toBe("🔄 Processing");
  });

  it("handles URL with special characters", () => {
    const result = qp.formatQueueStatusMessage({ url: "https://example.com/path?query=value&other=test" });
    expect(result).toBe("URL: <https://example.com/path?query=value&other=test>");
  });

  it("handles multiline note", () => {
    const result = qp.formatQueueStatusMessage({ note: "Line 1\nLine 2" });
    expect(result).toBe("Line 1\nLine 2");
  });
});
