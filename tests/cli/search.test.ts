import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "src", "cli", "index.ts");

const runCli = (args: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } => {
  const baseEnv = {
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test",
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "test-token",
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || "test-channel",
    LLM_BASE_URL: process.env.LLM_BASE_URL || "http://localhost:8080",
    LLM_MODEL: process.env.LLM_MODEL || "test-model",
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

describe("sb search command", () => {
  describe("basic usage", () => {
    it("should show error when no query is provided", () => {
      const { stderr, exitCode } = runCli(["search"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Error");
    });
    
    it("should show usage information in error when no query provided", () => {
      const { stderr } = runCli(["search"]);
      
      expect(stderr).toContain("Usage: sb search");
    });
  });
  
  describe("argument parsing", () => {
    it("should accept a simple query", () => {
      // This will fail due to missing LLM service, but we're testing argument parsing
      const { stderr } = runCli(["search", "test query"]);
      
      // Should fail at LLM/embed step, not argument parsing
      expect(stderr).not.toContain("Usage:");
    });
    
    it("should accept query with special characters", () => {
      const { stderr } = runCli(['search', 'query with "quotes" and \'apostrophes\'']);
      
      // Should not crash on special characters
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should accept query with unicode characters", () => {
      const { stderr } = runCli(["search", "machine learning 机器学习"]);
      
      // Should handle unicode
      expect(stderr).not.toContain("Unknown option");
    });
  });
  
  describe("--limit flag", () => {
    it("should accept --limit with valid value", () => {
      const { stderr } = runCli(["search", "--limit", "10", "test"]);
      
      // Should not fail on argument parsing
      expect(stderr).not.toContain("must be between 1 and 20");
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should accept -l shorthand", () => {
      const { stderr } = runCli(["search", "-l", "5", "test"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should reject limit below 1", () => {
      const { stderr, exitCode } = runCli(["search", "--limit", "0", "test"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("must be between 1 and 20");
    });
    
    it("should reject limit above 20", () => {
      const { stderr, exitCode } = runCli(["search", "--limit", "25", "test"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("must be between 1 and 20");
    });
    
    it("should reject non-numeric limit", () => {
      const { stderr, exitCode } = runCli(["search", "--limit", "abc", "test"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("must be between 1 and 20");
    });
    
    it("should show error when --limit has no value", () => {
      const { stderr, exitCode } = runCli(["search", "--limit"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("requires a value");
    });
  });
  
  describe("--format flag", () => {
    it("should accept --format table", () => {
      const { stderr } = runCli(["search", "--format", "table", "test"]);
      
      expect(stderr).not.toContain("Invalid format");
    });
    
    it("should accept --format json", () => {
      const { stderr } = runCli(["search", "--format", "json", "test"]);
      
      expect(stderr).not.toContain("Invalid format");
    });
    
    it("should accept --format urls-only", () => {
      const { stderr } = runCli(["search", "--format", "urls-only", "test"]);
      
      expect(stderr).not.toContain("Invalid format");
    });
    
    it("should accept -f shorthand", () => {
      const { stderr } = runCli(["search", "-f", "json", "test"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should reject invalid format", () => {
      const { stderr, exitCode } = runCli(["search", "--format", "xml", "test"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Invalid format");
    });
    
    it("should show error when --format has no value", () => {
      const { stderr, exitCode } = runCli(["search", "--format"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("requires a value");
    });
  });
  
  describe("--verbose flag", () => {
    it("should accept --verbose", () => {
      const { stderr } = runCli(["search", "--verbose", "test"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should accept -v shorthand", () => {
      const { stderr } = runCli(["search", "-v", "test"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
  });
  
  describe("combined options", () => {
    it("should accept multiple flags together", () => {
      const { stderr } = runCli(["search", "--verbose", "--limit", "10", "--format", "json", "test query"]);
      
      expect(stderr).not.toContain("Unknown option");
      // Argument parsing should succeed; execution may fail due to missing LLM service
      expect(stderr).not.toMatch(/Error:.*--(verbose|limit|format)/);
    });
    
    it("should accept short flags together", () => {
      const { stderr } = runCli(["search", "-v", "-l", "10", "-f", "json", "test"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
  });
  
  describe("error handling", () => {
    it("should return exit code 2 for invalid arguments", () => {
      const { exitCode } = runCli(["search", "--invalid-flag", "test"]);
      
      expect(exitCode).toBe(2);
    });
    
    it("should return exit code 2 for missing query", () => {
      const { exitCode } = runCli(["search"]);
      
      expect(exitCode).toBe(2);
    });
    
    it("should return exit code 2 for out-of-range limit", () => {
      const { exitCode } = runCli(["search", "--limit", "100", "test"]);
      
      expect(exitCode).toBe(2);
    });
  });
  
  describe("help integration", () => {
    it("should show search in --help output", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("search");
      expect(stdout).toContain("Perform semantic search");
    });
    
    it("should show search command usage in help", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("sb search");
      expect(stdout).toContain("--limit");
      expect(stdout).toContain("--format");
    });
  });
  
  describe("query handling", () => {
    it("should handle multi-word queries", () => {
      const { stderr } = runCli(["search", "machine learning algorithms"]);
      
      // Should not error on multi-word query
      expect(stderr).not.toContain("Usage:");
    });
    
    it("should handle queries with punctuation", () => {
      const { stderr } = runCli(['search', 'What is "machine learning"?']);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should handle very long queries", () => {
      const longQuery = "a".repeat(500);
      const { stderr } = runCli(["search", longQuery]);
      
      // Should not crash on long query
      expect(stderr).not.toContain("Unknown option");
    });
  });
});
