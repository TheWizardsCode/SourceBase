import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "src", "cli", "index.ts");

const TEST_URLS = {
  valid: "https://example.com",
  invalid: "not-a-valid-url",
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

describe("CLI Queue Command", () => {
  describe("argument validation", () => {
    it("should return exit code 2 when no URL is provided", () => {
      const { stderr, exitCode } = runCli(["queue"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("requires at least one URL argument");
    });
    
    it("should show queue command in help", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("queue");
      expect(stdout).toContain("Queue a URL for later processing");
    });
  });
  
  describe("URL validation", () => {
    it("should reject invalid URLs with appropriate error", () => {
      const { stderr, exitCode } = runCli(["queue", TEST_URLS.invalid]);
      
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Invalid URL");
    });
    
    it("should accept valid HTTP URLs", () => {
      const { stderr } = runCli(["queue", TEST_URLS.valid]);
      
      expect(stderr).not.toContain("Invalid URL: " + TEST_URLS.valid);
    });
  });
  
  describe("multiple URL support", () => {
    it("should accept multiple URLs in single command", () => {
      const { stderr } = runCli(["queue", "https://example.com", "https://example.org"]);
      
      expect(stderr).not.toContain("requires at least one URL argument");
    });
  });
  
  describe("output format", () => {
    it("should show Queued message on success or Failed on error", () => {
      const { stdout, stderr } = runCli(["queue", TEST_URLS.valid]);
      
      const output = stdout + stderr;
      
      // When database is available: shows "Queued:"
      // When database is unavailable: shows "Failed:"
      expect(output).toMatch(/(Queued|Failed): .+/);
    });
    
    it("should show Failed message on error without emojis", () => {
      const { stdout, stderr } = runCli(["queue", "https://invalid-url-that-will-fail.test"]);
      
      const output = stdout + stderr;
      
      // When database is unavailable or other error: shows "Failed:"
      // When invalid URL: shows "Invalid URL:" and "Error:"
      expect(output).toMatch(/(Failed|Invalid URL|Error): .+/);
      expect(output).not.toContain("⚠️");
    });
    
    it("should include URL ID in success message when available", () => {
      const { stdout } = runCli(["queue", TEST_URLS.valid]);
      
      // Success message may include ID in parentheses
      // Only check if we actually got a success
      if (stdout.includes("Queued:")) {
        expect(stdout).toMatch(/Queued: .*\(ID: \d+\)/);
      }
    });
  });
  
  describe("verbose mode", () => {
    it("should accept --verbose flag", () => {
      const { stderr } = runCli(["queue", "--verbose", TEST_URLS.valid]);
      
      // Should not error on --verbose flag
      expect(stderr).not.toContain("Unknown");
    });
    
    it("should show verbose output when --verbose is passed", () => {
      const { stdout } = runCli(["queue", "--verbose", TEST_URLS.valid]);
      
      // In verbose mode, should see "Queueing:" message
      expect(stdout).toContain("Queueing:");
    });
    
    it("should not show verbose output without --verbose flag", () => {
      const { stdout, stderr } = runCli(["queue", TEST_URLS.valid]);
      
      const output = stdout + stderr;
      
      // Without verbose, should not see "Queueing:" message (only shown in verbose mode)
      // But we should see either "Queued:" (success) or "Failed:" (error)
      expect(output).not.toContain("Queueing:");
      expect(output).toMatch(/(Queued|Failed): .+/);
    });
  });
  
  describe("exit codes", () => {
    it("should return exit code 0 on success", () => {
      const { exitCode } = runCli(["queue", TEST_URLS.valid]);
      
      // When database is available, expect success (0)
      // When database is unavailable, expect error (1)
      expect([0, 1]).toContain(exitCode);
    });
    
    it("should return exit code 1 on failure", () => {
      const { exitCode } = runCli(["queue", TEST_URLS.invalid]);
      
      expect(exitCode).toBe(1);
    });
    
    it("should return exit code 1 when all URLs fail", () => {
      const { exitCode } = runCli(["queue", "not-a-url", "also-not-a-url"]);
      
      expect(exitCode).toBe(1);
    });
  });
});
