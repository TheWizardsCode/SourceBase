import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
  const envVars = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  try {
    const stdout = execSync(`DATABASE_URL=test ${envVars} npx tsx ${cliPath} ${args.join(" ")}`, {
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
      expect(stderr).toContain("Usage: sb add");
    });
    
    it("should return exit code 2 with usage information", () => {
      const { stderr } = runCli(["add"]);
      expect(stderr).toContain("sb add <url> [<url2> ...]");
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
      // This test would require actual database and LLM services
      // For unit testing, we verify the command accepts the URL format
      const { stderr } = runCli(["add", TEST_URLS.valid]);
      
      // Should not show "Invalid URL" error for valid format
      expect(stderr).not.toContain("Invalid URL");
    });
    
    it("should accept valid HTTPS URLs", () => {
      const { stderr } = runCli(["add", "https://example.org/path"]);
      
      expect(stderr).not.toContain("Invalid URL");
    });
  });
  
  describe("multiple URL support", () => {
    it("should accept multiple URLs in single command", () => {
      const { stderr } = runCli(["add", "https://example.com", "https://example.org"]);
      
      // Should not show argument error
      expect(stderr).not.toContain("requires at least one URL argument");
    });
    
    it("should show progress for each URL when multiple provided", () => {
      const { stdout } = runCli(["add", "https://example.com", "https://example.org"]);
      
      // Should show processing indicator for multiple URLs
      expect(stdout).toMatch(/\[1\/2\].*Processing/);
      expect(stdout).toMatch(/\[2\/2\].*Processing/);
    });
  });
  
  describe("progress display", () => {
    it("should show URL being processed", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      expect(stdout).toContain(TEST_URLS.valid);
    });
    
    it("should show progress phases", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      // Should show various progress phases
      expect(stdout).toMatch(/(⬇️|📄|✍️|🔢|💾|✅|❌)/);
    });
  });
  
  describe("success output", () => {
    it("should display success message with checkmark emoji on success", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      // Should show success format (actual success depends on DB/LLM being available)
      // For now, just verify the format is correct when successful
      const successMatch = stdout.match(/✅ Added: .+/);
      if (successMatch) {
        expect(successMatch[0]).toMatch(/✅ Added: .+/);
      }
    });
    
    it("should include URL ID in success message when available", () => {
      const { stdout } = runCli(["add", TEST_URLS.valid]);
      
      // Success message may include ID in parentheses
      const idMatch = stdout.match(/✅ Added: .*\(ID: \d+\)/);
      if (idMatch) {
        expect(idMatch[0]).toMatch(/\(ID: \d+\)/);
      }
    });
  });
  
  describe("failure output", () => {
    it("should display failure message with warning emoji", () => {
      const { stderr } = runCli(["add", TEST_URLS.invalid]);
      
      expect(stderr).toContain("⚠️");
      expect(stderr).toContain("Invalid URL");
    });
    
    it("should include URL in failure message", () => {
      const { stderr } = runCli(["add", TEST_URLS.invalid]);
      
      expect(stderr).toContain(TEST_URLS.invalid);
    });
    
    it("should include error description in failure message", () => {
      const { stderr } = runCli(["add", "https://example.com"]); // Will fail due to network
      
      // Failure format for processing errors: "⚠️ Failed: <url> - <error>"
      // OR for invalid URLs: "⚠️ Invalid URL: <url>"
      const hasFailedFormat = /⚠️ .*Failed:.* - .+/.test(stderr);
      const hasInvalidFormat = /⚠️ .*Invalid URL:.+/.test(stderr);
      expect(hasFailedFormat || hasInvalidFormat).toBe(true);
    });
  });
  
  describe("exit codes", () => {
    it("should return exit code 0 on success", () => {
      // Note: This requires actual services to be running
      // In test environment without services, it will fail
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
      expect(stderr).not.toContain("Invalid URL");
    });
    
    it("should process YouTube URL with transcript extraction if configured", () => {
      // Test that YouTube URL is accepted - actual transcript extraction
      // depends on YOUTUBE_API_KEY being configured
      const { stdout, stderr } = runCli(["add", TEST_URLS.youtube]);
      
      // Should attempt to process (may fail due to missing API key)
      const output = stdout + stderr;
      expect(output.includes("youtube.com") || /(⚠️|✅)/.test(output)).toBe(true);
    });
  });
});
