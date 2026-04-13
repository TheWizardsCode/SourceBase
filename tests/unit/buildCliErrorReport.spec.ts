import { describe, it, expect } from "vitest";
import { buildCliErrorReport } from "../../src/discord/utils.js";

describe("buildCliErrorReport", () => {
  it("should include the error message prominently in the report", () => {
    const errorMsg = 'column "content_hash" of relation "contents" does not exist';
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
      stderr: "Some stderr content",
      note: "Test error report",
    });

    // Should include the error message section
    expect(report).toContain("--- Error Message ---");
    expect(report).toContain(errorMsg);
    
    // Error message should appear before stderr section
    const errorIndex = report.indexOf("--- Error Message ---");
    const stderrIndex = report.indexOf("--- stderr ---");
    expect(errorIndex).toBeLessThan(stderrIndex);
  });

  it("should include both error and stderr when both are provided", () => {
    const errorMsg = "Processing failed";
    const stderr = "Some stderr output";
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
      stderr: stderr,
    });

    expect(report).toContain("--- Error Message ---");
    expect(report).toContain(errorMsg);
    expect(report).toContain("--- stderr ---");
    expect(report).toContain(stderr);
  });

  it("should not include error section when error is not provided", () => {
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      stderr: "Some stderr output",
    });

    expect(report).not.toContain("--- Error Message ---");
    expect(report).toContain("--- stderr ---");
  });

  it("should include RCA for database schema errors based on error message", () => {
    const errorMsg = 'column "content_hash" of relation "contents" does not exist';
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
    });

    // Previously there was an RCA section here; that has been removed.
    // The report should still contain the error message itself.
    expect(report).toContain(errorMsg);
  });

  it("should include RCA for unique constraint errors", () => {
    const errorMsg = "duplicate key value violates unique constraint";
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
    });

    // RCA removed; ensure the error text is still present in the report.
    expect(report).toContain(errorMsg);
  });

  it("should include RCA for foreign key errors", () => {
    const errorMsg = "violates foreign key constraint";
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
    });

    // RCA removed; ensure the error text is still present in the report.
    expect(report).toContain(errorMsg);
  });

  it("should include RCA for processing errors", () => {
    const errorMsg = "failed extracting content";
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      error: errorMsg,
    });

    // RCA removed; ensure the error text is still present in the report.
    expect(report).toContain(errorMsg);
  });

  it("should handle empty error and stderr gracefully", () => {
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
    });

    // Should not have error or stderr sections
    expect(report).not.toContain("--- Error Message ---");
    expect(report).not.toContain("--- stderr ---");
    // But should still have basic report structure
    expect(report).toContain("⚠️ CLI Error Report");
    expect(report).toContain("Exit code: 1");
  });

  it("should include command and exit code", () => {
    const report = buildCliErrorReport({
      command: "stats",
      args: [],
      exitCode: 127,
    });

    expect(report).toContain("Command: `stats `");
    expect(report).toContain("Exit code: 127");
  });

  it("should include spawn error when provided", () => {
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      spawnError: "ENOENT: no such file or directory",
    });

    expect(report).toContain("Spawn error: ENOENT: no such file or directory");
    expect(report).toContain("The CLI failed to start (spawn error)");
  });

  it("should include note when provided", () => {
    const report = buildCliErrorReport({
      command: "add --format ndjson https://example.com/article",
      args: [],
      exitCode: 1,
      note: "Observed during user request",
    });

    expect(report).toContain("Note: Observed during user request");
  });
});
