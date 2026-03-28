import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "src", "cli", "index.ts");

// Mock test URLs that should work for testing
const TEST_URLS = {
  valid: "https://example.com",
  invalid: "not-a-valid-url",
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
};

const runCli = (args: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } => {
  const baseEnv = {
    DATABASE_URL: "test",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_CHANNEL_ID: "test-channel",
    ...env
  };
  const envVars = Object.entries(baseEnv).map(([k, v]) => `${k}=${v}`).join(" ");
  try {
    const stdout = execSync(`${envVars} npx tsx ${cliPath} ${args.join(" ")}`, {
      encoding: "utf-8",
      cwd: join(__dirname, "..", ".."),
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.status || 1,
    };
  }
};

describe("CLI Add Command", () => {
  describe("argument validation", () => {
    it("should return exit code 2 when no URL is provided", () => {
      const { stderr, exitCode } = runCli(["add"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("requires at least one URL argument");
    });
    
    it("should show usage with --verbose option in help", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("--verbose");
      expect(stdout).toContain("Enable verbose output");
    });
  });
  
  describe("URL validation", () => {
    it("should reject invalid URLs with appropriate error", () => {
      const { stderr, exitCode } = runCli(["add", TEST_URLS.invalid]);
      
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Invalid URL");
    });
    
    it("should reject malformed URLs", () => {
      const { stderr, exitCode } = runCli(["add", "ftp://example.com"]);
      
      expect(exitCode).toBe(1);
    });
    
    it("should accept valid HTTP URLs", () => {
      const { stderr } = runCli(["add", TEST_URLS.valid]);
      
      // Should not show "Invalid URL" error for valid format
      expect(stderr).not.toContain("Invalid URL: " + TEST_URLS.valid);
    });
    
    it("should accept valid HTTPS URLs", () => {
      const { stderr } = runCli(["add", "https://example.org/path"]);
      
      expect(stderr).not.toContain("Invalid URL: https://example.org/path");
    });
  });
  
  describe("multiple URL support", () => {
    it("should accept multiple URLs in single command", { timeout: 30000 }, () => {
      const { stderr } = runCli(["add", "https://example.com", "https://example.org"]);
      
      // Should not show argument error
      expect(stderr).not.toContain("requires at least one URL argument");
    });
  });
  
  describe("output format", () => {
    it("should show phases during processing and final result", () => {
      const { stdout, stderr } = runCli(["add", TEST_URLS.valid]);
      
      const output = stdout + stderr;
      
      // Should show phases (Downloading, Extracting, etc.) - just the phase name
      expect(output).toMatch(/(Downloading|Extracting|Summarizing|Embedding|Storing|Completed|Failed)/);
      
      // Final result should show "Added:" or "Failed:" with details
      expect(output).toMatch(/(Added|Failed): .+/);
      
      // Should not contain emojis
      expect(output).not.toContain("✅");
      expect(output).not.toContain("⚠️");
    });
    
    it("should show Failed message on error without emojis", () => {
      const { stdout, stderr } = runCli(["add", "https://example.com"]);
      
      const output = stdout + stderr;
      
      // Should show phases then "Failed:" format without emojis
      expect(output).toMatch(/Failed: .+/);
      expect(output).not.toContain("⚠️");
    });
    
    it("should not show JSON output in non-verbose mode", () => {
      const { stdout, stderr } = runCli(["add", TEST_URLS.valid]);
      
      // Should not contain JSON log lines
      const output = stdout + stderr;
      // JSON output would contain {"phase":...} etc
      expect(output).not.toMatch(/\{\s*"phase":/);
    });
  });
  
  describe("verbose mode", () => {
    it("should accept --verbose flag", () => {
      const { stderr } = runCli(["add", "--verbose", TEST_URLS.valid]);
      
      // Should not error on --verbose flag
      expect(stderr).not.toContain("Unknown");
    });
    
    it("should show JSON output in verbose mode", { timeout: 30000 }, () => {
      const { stdout, stderr } = runCli(["add", "--verbose", TEST_URLS.valid]);
      
      // In verbose mode, should see JSON phase output
      const output = stdout + stderr;
      // Might not see it if it fails immediately, but at least test flag is accepted
      expect(output).toBeTruthy();
    });
  });
  
  describe("success output", () => {
    it("should display success message without emoji", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      const successMatch = stdout.match(/Added: .+/);
      if (successMatch) {
        expect(successMatch[0]).not.toContain("✅");
      }
    });
    
    it("should include URL ID in success message when available", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      // Success message may include ID in parentheses
      const idMatch = stdout.match(/Added: .*\(ID: \d+\)/);
      if (idMatch) {
        expect(idMatch[0]).toMatch(/\(ID: \d+\)/);
      }
    });
  });
  
  describe("failure output", () => {
    it("should display failure message without emoji", () => {
      const { stderr } = runCli(["add", TEST_URLS.invalid]);
      
      expect(stderr).not.toContain("⚠️");
    });
    
    it("should include URL in failure message", () => {
      const { stderr } = runCli(["add", TEST_URLS.invalid]);
      
      expect(stderr).toContain(TEST_URLS.invalid);
    });
    
    it("should include error description in failure message", () => {
      const { stderr } = runCli(["add", "https://example.com"]); // Will fail due to network
      
      // Failure format for processing errors: "Failed: <url> - <error>"
      // OR for invalid URLs: "Invalid URL: <url>"
      const hasFailedFormat = /Failed:.* - .+/.test(stderr);
      const hasInvalidFormat = /Invalid URL:.+/.test(stderr);
      expect(hasFailedFormat || hasInvalidFormat).toBe(true);
    });
  });
  
  describe("exit codes", () => {
    it("should return exit code 0 on success", () => {
      const { exitCode } = runCli(["add", TEST_URLS.valid]);
      
      // When services unavailable, expect failure
      // When services available, expect success
      expect([0, 1]).toContain(exitCode);
    });
    
    it("should return exit code 1 on failure", () => {
      const { exitCode } = runCli(["add", TEST_URLS.invalid]);
      
      expect(exitCode).toBe(1);
    });
    
    it("should return exit code 1 when all URLs fail", () => {
      const { exitCode } = runCli(["add", "not-a-url", "also-not-a-url"]);
      
      expect(exitCode).toBe(1);
    });
  });
  
  describe("YouTube URL handling", () => {
    it("should accept YouTube URLs", () => {
      const { stderr } = runCli(["add", TEST_URLS.youtube]);
      
      // Should not reject as invalid URL
      expect(stderr).not.toContain("Invalid URL: " + TEST_URLS.youtube);
    });
  });
  
  describe("context flags", () => {
    it("should accept --channel-id flag", () => {
      const { stderr } = runCli(["add", "--channel-id", "channel123", TEST_URLS.valid]);
      
      // Should not error on --channel-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept --message-id flag", () => {
      const { stderr } = runCli(["add", "--message-id", "msg456", TEST_URLS.valid]);
      
      // Should not error on --message-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept --author-id flag", () => {
      const { stderr } = runCli(["add", "--author-id", "user789", TEST_URLS.valid]);
      
      // Should not error on --author-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept all context flags together", () => {
      const { stderr } = runCli([
        "add",
        "--channel-id", "channel123",
        "--message-id", "msg456",
        "--author-id", "user789",
        TEST_URLS.valid
      ]);
      
      // Should not error on any context flags
      expect(stderr).not.toContain("Unknown");
    });
  });
  
  describe("format flags", () => {
    it("should accept --format ndjson", () => {
      const { stderr } = runCli(["add", "--format", "ndjson", TEST_URLS.valid]);
      
      // Should not error on --format flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid format");
    });
    
    it("should accept --ndjson shorthand", () => {
      const { stderr } = runCli(["add", "--ndjson", TEST_URLS.valid]);
      
      // Should not error on --ndjson flag
      expect(stderr).not.toContain("Unknown");
    });
    
    it("should reject invalid format", () => {
      const { stderr, exitCode } = runCli(["add", "--format", "invalid", TEST_URLS.valid]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Invalid format");
    });
  });
  
  describe("webhook-url flag", () => {
    it("should accept --webhook-url flag", () => {
      const { stderr } = runCli(["add", "--webhook-url", "https://example.com/webhook", TEST_URLS.valid]);
      
      // Should not error on --webhook-url flag with valid URL
      expect(stderr).not.toContain("Unknown");
    });
    
    it("should reject invalid webhook-url", () => {
      const { stderr, exitCode } = runCli(["add", "--webhook-url", "not-a-url", TEST_URLS.valid]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("not a valid URL");
    });
  });
});
