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
        expect(stderr).toContain("DATABASE_URL environment variable is required");
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
});
