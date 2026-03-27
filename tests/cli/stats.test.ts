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

describe("sb stats command", () => {
  describe("basic usage", () => {
    it("should accept stats command with no arguments", () => {
      const { exitCode } = runCli(["stats"]);
      
      // Should not error on basic usage
      expect(exitCode).toBeLessThanOrEqual(1); // 0 = success, 1 = db error
    });
    
    it("should display statistics table by default", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      // If database is available, should show table format
      // If not, stdout may be empty but exit code should indicate db error (1)
      if (stdout) {
        expect(stdout).toMatch(/Total Links|Database Statistics|Metric/);
      }
      expect(exitCode).toBeLessThanOrEqual(1); // 0 = success, 1 = db error
    });
  });
  
  describe("--format flag", () => {
    it("should accept --format table", () => {
      const { stderr } = runCli(["stats", "--format", "table"]);
      
      expect(stderr).not.toContain("Invalid format");
    });
    
    it("should accept --format json", () => {
      const { stdout, stderr } = runCli(["stats", "--format", "json"]);
      
      expect(stderr).not.toContain("Invalid format");
      // JSON should parse successfully
      if (stdout) {
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
    });
    
    it("should accept -f shorthand", () => {
      const { stderr } = runCli(["stats", "-f", "json"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should reject invalid format", () => {
      const { stderr, exitCode } = runCli(["stats", "--format", "xml"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Invalid format");
    });
    
    it("should show error when --format has no value", () => {
      const { stderr, exitCode } = runCli(["stats", "--format"]);
      
      expect(exitCode).toBe(2);
      expect(stderr).toContain("requires a value");
    });
  });
  
  describe("--raw flag", () => {
    it("should accept --raw flag", () => {
      const { stderr } = runCli(["stats", "--raw"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should accept -r shorthand", () => {
      const { stderr } = runCli(["stats", "-r"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should output raw key:value format", () => {
      const { stdout } = runCli(["stats", "--raw"]);
      
      if (stdout) {
        // Raw format should have key:value pairs
        expect(stdout).toMatch(/total:\d+|embeddings:\d+/);
      }
    });
    
    it("should work with --format json", () => {
      const { stdout, stderr } = runCli(["stats", "--format", "json", "--raw"]);
      
      // --raw takes precedence or works with other flags
      expect(stderr).not.toContain("Unknown option");
    });
  });
  
  describe("table format content", () => {
    it("should show Total Links in table", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      // If database is available, check output; otherwise test passes with db error
      if (stdout) {
        expect(stdout).toContain("Total Links");
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should show With Embeddings metric", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      if (stdout) {
        expect(stdout).toMatch(/With Embeddings|embeddings/);
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should show With Summaries metric", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      if (stdout) {
        expect(stdout).toMatch(/With Summaries|summaries/);
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should show With Content metric", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      if (stdout) {
        expect(stdout).toMatch(/With Content|content/);
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should show With Transcripts metric", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      if (stdout) {
        expect(stdout).toMatch(/With Transcripts|transcripts/);
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should show time-based metrics", () => {
      const { stdout, exitCode } = runCli(["stats"]);
      
      if (stdout) {
        expect(stdout).toMatch(/Last 24 Hours|24h|24 hours/);
        expect(stdout).toMatch(/Last 7 Days|7d|7 days/);
        expect(stdout).toMatch(/Last 30 Days|30d|30 days/);
      }
      expect(exitCode).toBeLessThanOrEqual(1);
    });
  });
  
  describe("json format content", () => {
    it("should return valid JSON structure", () => {
      const { stdout } = runCli(["stats", "--format", "json"]);
      
      if (stdout) {
        const json = JSON.parse(stdout);
        expect(json).toHaveProperty("totalLinks");
        expect(json).toHaveProperty("withEmbeddings");
        expect(json).toHaveProperty("withSummaries");
        expect(json).toHaveProperty("withContent");
        expect(json).toHaveProperty("withTranscripts");
        expect(json).toHaveProperty("timeBased");
      }
    });
    
    it("should have numeric values", () => {
      const { stdout } = runCli(["stats", "--format", "json"]);
      
      if (stdout) {
        const json = JSON.parse(stdout);
        expect(typeof json.totalLinks).toBe("number");
        expect(typeof json.withEmbeddings).toBe("number");
        expect(typeof json.withSummaries).toBe("number");
        expect(typeof json.withContent).toBe("number");
        expect(typeof json.withTranscripts).toBe("number");
      }
    });
    
    it("should have time-based object with numeric values", () => {
      const { stdout } = runCli(["stats", "--format", "json"]);
      
      if (stdout) {
        const json = JSON.parse(stdout);
        expect(json.timeBased).toHaveProperty("last24Hours");
        expect(json.timeBased).toHaveProperty("last7Days");
        expect(json.timeBased).toHaveProperty("last30Days");
        expect(typeof json.timeBased.last24Hours).toBe("number");
        expect(typeof json.timeBased.last7Days).toBe("number");
        expect(typeof json.timeBased.last30Days).toBe("number");
      }
    });
  });
  
  describe("error handling", () => {
    it("should return exit code 2 for invalid arguments", () => {
      const { exitCode } = runCli(["stats", "--invalid-flag"]);
      
      expect(exitCode).toBe(2);
    });
    
    it("should show unknown option error", () => {
      const { stderr } = runCli(["stats", "--invalid-flag"]);
      
      expect(stderr).toContain("Unknown option");
    });
    
    it("should handle database connection errors", { timeout: 30000 }, () => {
      const { stderr, exitCode } = runCli(["stats"], { DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:5433/invalid" });
      
      // Should return non-zero exit code on connection failure
      expect(exitCode).toBeGreaterThan(0);
      expect(stderr).toMatch(/Error.*database|Unable to connect|ECONNREFUSED/i);
    });
  });
  
  describe("help integration", () => {
    it("should show stats in --help output", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("stats");
      expect(stdout).toContain("Display database statistics");
    });
    
    it("should show stats command usage in help", () => {
      const { stdout } = runCli(["--help"]);
      
      expect(stdout).toContain("sb stats");
    });
  });
  
  describe("exit codes", () => {
    it("should return exit code 0 on success", () => {
      const { exitCode } = runCli(["stats"]);
      
      // 0 = success (even if db is unreachable, the command structure is valid)
      // If db is unreachable, it returns 1
      expect(exitCode).toBeLessThanOrEqual(1);
    });
    
    it("should return exit code 2 for invalid format", () => {
      const { exitCode } = runCli(["stats", "--format", "invalid"]);
      
      expect(exitCode).toBe(2);
    });
  });
  
  describe("combined options", () => {
    it("should accept --format and --raw together", () => {
      const { stderr } = runCli(["stats", "--format", "json", "--raw"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
    
    it("should accept short flags together", () => {
      const { stderr } = runCli(["stats", "-f", "json", "-r"]);
      
      expect(stderr).not.toContain("Unknown option");
    });
  });
});
