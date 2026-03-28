import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "src", "cli", "index.ts");

const runCli = (args: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } => {
  const baseEnv = {
    DATABASE_URL: "test",
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

describe("CLI Entry Point", () => {
  describe("--help flag", () => {
    it("should display usage information for all commands", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: sb <command> [options]");
      expect(stdout).toContain("Commands:");
      expect(stdout).toContain("add");
      expect(stdout).toContain("search");
      expect(stdout).toContain("stats");
      expect(stdout).toContain("Options:");
      expect(stdout).toContain("--help");
      expect(stdout).toContain("--version");
    });
    
    it("should display usage information with -h flag", () => {
      const { stdout, exitCode } = runCli(["-h"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: sb <command> [options]");
    });
  });
  
  describe("--version flag", () => {
    it("should display version information", () => {
      const { stdout, exitCode } = runCli(["--version"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("sb version");
      expect(stdout).toMatch(/sb version \d+\.\d+\.\d+/);
    });
    
    it("should display version information with -v flag", () => {
      const { stdout, exitCode } = runCli(["-v"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("sb version");
    });
  });
  
  describe("unknown command", () => {
    it("should return error message with unknown command name", () => {
      const { stderr, exitCode } = runCli(["unknown-command"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown command "unknown-command"');
    });
    
    it("should suggest sb --help in error message", () => {
      const { stderr } = runCli(["unknown-command"]);
      
      expect(stderr).toContain("sb --help");
    });
  });
  
  describe("no arguments", () => {
    it("should display help when no command is provided", () => {
      const { stdout, exitCode } = runCli([]);
      
      expect(exitCode).toBe(2);
      expect(stdout).toContain("Usage: sb <command> [options]");
    });
  });
  
  describe("configuration validation", () => {
    it("should output DATABASE_URL error to stderr when DATABASE_URL is missing", () => {
      try {
        execSync(`npx tsx ${cliPath} stats`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: { ...process.env, DATABASE_URL: "" },
        });
        // If we get here, the test failed
        expect(true).toBe(false);
      } catch (error: any) {
        const stderr = error.stderr || "";
        expect(stderr).toContain("Configuration validation failed");
        expect(stderr).toContain("DATABASE_URL");
        expect(error.status).toBe(1);
      }
    });
  });
  
  describe("exit codes", () => {
    it("should return exit code 0 for --help", () => {
      const { exitCode } = runCli(["--help"]);
      expect(exitCode).toBe(0);
    });
    
    it("should return exit code 0 for --version", () => {
      const { exitCode } = runCli(["--version"]);
      expect(exitCode).toBe(0);
    });
    
    it("should return exit code 2 for unknown command", () => {
      const { exitCode } = runCli(["unknown-command"]);
      expect(exitCode).toBe(2);
    });
    
    it("should return exit code 2 for missing arguments", () => {
      const { exitCode } = runCli([]);
      expect(exitCode).toBe(2);
    });
    
    it("should return exit code 1 for configuration errors", () => {
      try {
        execSync(`npx tsx ${cliPath} stats`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: { ...process.env, DATABASE_URL: "" },
        });
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.status).toBe(1);
      }
    });
  });
  
  describe("command descriptions", () => {
    it("should display add command description", () => {
      const { stdout } = runCli(["--help"]);
      expect(stdout).toContain("Add a URL to the database");
    });
    
    it("should display search command description", () => {
      const { stdout } = runCli(["--help"]);
      expect(stdout).toContain("Perform semantic search on indexed content");
    });
    
    it("should display stats command description", () => {
      const { stdout } = runCli(["--help"]);
      expect(stdout).toContain("Display database statistics");
    });
  });
  
  describe("context flags", () => {
    it("should display context flags in help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--channel-id");
      expect(stdout).toContain("--message-id");
      expect(stdout).toContain("--author-id");
    });
    
    it("should accept --channel-id flag with add command", () => {
      const { stderr } = runCli(["add", "--channel-id", "12345", "https://example.com"]);
      
      // Should not error on --channel-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept --message-id flag with queue command", () => {
      const { stderr } = runCli(["queue", "--message-id", "67890", "https://example.com"]);
      
      // Should not error on --message-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept --author-id flag", () => {
      const { stderr } = runCli(["add", "--author-id", "user123", "https://example.com"]);
      
      // Should not error on --author-id flag
      expect(stderr).not.toContain("Unknown");
      expect(stderr).not.toContain("Invalid");
    });
    
    it("should accept all context flags together", () => {
      const { stderr } = runCli([
        "queue",
        "--channel-id", "channel123",
        "--message-id", "msg456",
        "--author-id", "user789",
        "https://example.com"
      ]);
      
      // Should not error on any context flags
      expect(stderr).not.toContain("Unknown");
    });
  });
  
  describe("format flags", () => {
    it("should display format options in help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--format");
      expect(stdout).toContain("--ndjson");
    });
    
    it("should accept --ndjson flag as shorthand for --format ndjson", () => {
      const { stderr } = runCli(["add", "--ndjson", "https://example.com"]);
      
      // Should not error on --ndjson flag
      expect(stderr).not.toContain("Unknown");
    });
  });
  
  describe("webhook-url validation", () => {
    it("should display webhook-url option in help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--webhook-url");
    });
    
    it("should return exit code 2 for invalid webhook-url", () => {
      const { stderr, exitCode } = runCli(["add", "--webhook-url", "not-a-url", "https://example.com"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("not a valid URL");
    });
    
    it("should return exit code 2 for non-HTTP webhook-url", () => {
      const { stderr, exitCode } = runCli(["add", "--webhook-url", "ftp://example.com/hook", "https://example.com"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("must be a valid HTTP or HTTPS URL");
    });
    
    it("should accept valid HTTPS webhook-url", () => {
      const { stderr } = runCli(["add", "--webhook-url", "https://example.com/webhook", "https://example.com"]);
      
      // Should not error on valid webhook URL
      expect(stderr).not.toContain("not a valid URL");
      expect(stderr).not.toContain("Unknown");
    });
  });
});
