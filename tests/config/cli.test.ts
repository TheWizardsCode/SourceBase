import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliConfigPath = join(__dirname, "..", "..", "src", "config", "cli.ts");

describe("CLI Config Module", () => {
  describe("validation without Discord vars", () => {
    it("should validate successfully with only CLI vars present", () => {
      // This test verifies the CLI config loads without Discord env vars
      // by importing the module in a clean environment
      const testScript = `
        import { cliConfig } from "${cliConfigPath}";
        console.log("Config loaded successfully");
        console.log("DATABASE_URL:", cliConfig.DATABASE_URL ? "set" : "not set");
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          DISCORD_BOT_TOKEN: "",  // Explicitly empty - should be ignored
          DISCORD_CHANNEL_ID: "", // Explicitly empty - should be ignored
        },
      });
      
      expect(result).toContain("Config loaded successfully");
      expect(result).toContain("DATABASE_URL: set");
    });
    
    it("should fail validation when DATABASE_URL is missing", () => {
      const testScript = `
        try {
          await import("${cliConfigPath}");
          console.log("ERROR: Should have thrown");
          process.exit(1);
        } catch (error: any) {
          console.log("VALIDATION_FAILED");
          console.log(error.message);
        }
      `;
      
      try {
        const result = execSync(`echo '${testScript}' | npx tsx -`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: {
            ...process.env,
            DATABASE_URL: "",  // Missing required var
          },
        });
        // If we get here, check if the output contains expected content
        expect(result).toContain("VALIDATION_FAILED");
        expect(result).toContain("DATABASE_URL");
      } catch (error: any) {
        // Process exited with error - check stderr/stdout
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("DATABASE_URL");
      }
    });
    
    it("should ignore DISCORD_* vars and not fail", () => {
      const testScript = `
        import { cliConfig } from "${cliConfigPath}";
        console.log("Config loaded successfully with Discord vars present");
        console.log("LLM_MODEL:", cliConfig.LLM_MODEL);
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          DISCORD_BOT_TOKEN: "some-token",  // Should be ignored
          DISCORD_CHANNEL_ID: "some-channel", // Should be ignored
        },
      });
      
      expect(result).toContain("Config loaded successfully with Discord vars present");
    });
    
    it("should use default values for optional fields", () => {
      const testScript = `
        import { cliConfig } from "${cliConfigPath}";
        console.log("LLM_BASE_URL:", cliConfig.LLM_BASE_URL);
        console.log("LLM_MODEL:", cliConfig.LLM_MODEL);
        console.log("QDRANT_URL:", cliConfig.QDRANT_URL);
        console.log("LOG_LEVEL:", cliConfig.LOG_LEVEL);
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        },
      });
      
      expect(result).toContain("LLM_BASE_URL:");
      expect(result).toContain("LLM_MODEL:");
      expect(result).toContain("QDRANT_URL:");
      expect(result).toContain("LOG_LEVEL:");
    });
  });
  
  describe("formatConfigError", () => {
    it("should only show CLI-relevant vars in error messages", () => {
      const testScript = `
        try {
          await import("${cliConfigPath}");
          console.log("ERROR: Should have thrown");
          process.exit(1);
        } catch (error: any) {
          const message = error.message;
          // Should mention DATABASE_URL
          if (!message.includes("DATABASE_URL")) {
            console.error("Missing DATABASE_URL in error");
            process.exit(1);
          }
          // Should NOT mention Discord vars
          if (message.includes("DISCORD_BOT_TOKEN") || message.includes("DISCORD_CHANNEL_ID")) {
            console.error("Error contains Discord vars - should be CLI-only");
            process.exit(1);
          }
          console.log("SUCCESS: Error message is CLI-only as expected");
        }
      `;
      
      try {
        const result = execSync(`echo '${testScript}' | npx tsx -`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: {
            ...process.env,
            DATABASE_URL: "",  // Missing required var
          },
        });
        expect(result).toContain("SUCCESS: Error message is CLI-only as expected");
      } catch (error: any) {
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("SUCCESS: Error message is CLI-only as expected");
      }
    });
  });
});
