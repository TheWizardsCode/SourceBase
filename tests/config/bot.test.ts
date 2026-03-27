import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botConfigPath = join(__dirname, "..", "..", "src", "config", "bot.ts");

describe("Bot Config Module", () => {
  describe("validation with Discord vars", () => {
    it("should validate successfully with all required vars present", () => {
      const testScript = `
        import { botConfig } from "${botConfigPath}";
        console.log("Bot config loaded successfully");
        console.log("DATABASE_URL:", botConfig.DATABASE_URL ? "set" : "not set");
        console.log("DISCORD_BOT_TOKEN:", botConfig.DISCORD_BOT_TOKEN ? "set" : "not set");
        console.log("DISCORD_CHANNEL_ID:", botConfig.DISCORD_CHANNEL_ID ? "set" : "not set");
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_CHANNEL_ID: "123456789012345678",
        },
      });
      
      expect(result).toContain("Bot config loaded successfully");
      expect(result).toContain("DATABASE_URL: set");
      expect(result).toContain("DISCORD_BOT_TOKEN: set");
      expect(result).toContain("DISCORD_CHANNEL_ID: set");
    });
    
    it("should fail validation when DISCORD_BOT_TOKEN is missing", () => {
      const testScript = `
        try {
          await import("${botConfigPath}");
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
            DATABASE_URL: "postgresql://test:test@localhost:5432/test",
            DISCORD_BOT_TOKEN: "",  // Missing required var
            DISCORD_CHANNEL_ID: "123456789012345678",
          },
        });
        expect(result).toContain("VALIDATION_FAILED");
        expect(result).toContain("DISCORD_BOT_TOKEN");
      } catch (error: any) {
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("DISCORD_BOT_TOKEN");
      }
    });
    
    it("should fail validation when DISCORD_CHANNEL_ID is missing", () => {
      const testScript = `
        try {
          await import("${botConfigPath}");
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
            DATABASE_URL: "postgresql://test:test@localhost:5432/test",
            DISCORD_BOT_TOKEN: "test-bot-token",
            DISCORD_CHANNEL_ID: "",  // Missing required var
          },
        });
        expect(result).toContain("VALIDATION_FAILED");
        expect(result).toContain("DISCORD_CHANNEL_ID");
      } catch (error: any) {
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("DISCORD_CHANNEL_ID");
      }
    });
    
    it("should include CLI config fields via extension", () => {
      const testScript = `
        import { botConfig } from "${botConfigPath}";
        console.log("LLM_BASE_URL:", botConfig.LLM_BASE_URL);
        console.log("LLM_MODEL:", botConfig.LLM_MODEL);
        console.log("QDRANT_URL:", botConfig.QDRANT_URL);
        console.log("LOG_LEVEL:", botConfig.LOG_LEVEL);
        console.log("Has CLI fields:", !!botConfig.DATABASE_URL);
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_CHANNEL_ID: "123456789012345678",
        },
      });
      
      expect(result).toContain("LLM_BASE_URL:");
      expect(result).toContain("LLM_MODEL:");
      expect(result).toContain("QDRANT_URL:");
      expect(result).toContain("LOG_LEVEL:");
      expect(result).toContain("Has CLI fields: true");
    });
    
    it("should have bot-specific fields", () => {
      const testScript = `
        import { botConfig } from "${botConfigPath}";
        console.log("Has ALLOWED_FILE_URL_USERS:", Array.isArray(botConfig.ALLOWED_FILE_URL_USERS));
        console.log("Has BACKFILL_INTERVAL_MS:", typeof botConfig.BACKFILL_INTERVAL_MS === "number");
        console.log("Has MAX_BACKFILL_ATTEMPTS:", typeof botConfig.MAX_BACKFILL_ATTEMPTS === "number");
        console.log("Has STARTUP_RECOVERY_MAX_MESSAGES:", typeof botConfig.STARTUP_RECOVERY_MAX_MESSAGES === "number");
      `;
      
      const result = execSync(`echo '${testScript}' | npx tsx -`, {
        encoding: "utf-8",
        cwd: join(__dirname, "..", ".."),
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_CHANNEL_ID: "123456789012345678",
        },
      });
      
      expect(result).toContain("Has ALLOWED_FILE_URL_USERS: true");
      expect(result).toContain("Has BACKFILL_INTERVAL_MS: true");
      expect(result).toContain("Has MAX_BACKFILL_ATTEMPTS: true");
      expect(result).toContain("Has STARTUP_RECOVERY_MAX_MESSAGES: true");
    });
  });
  
  describe("formatConfigError", () => {
    it("should show DATABASE_URL in error messages", () => {
      const testScript = `
        try {
          await import("${botConfigPath}");
          console.log("ERROR: Should have thrown");
          process.exit(1);
        } catch (error: any) {
          const message = error.message;
          // Should mention DATABASE_URL (first missing field)
          if (!message.includes("DATABASE_URL")) {
            console.error("Missing DATABASE_URL in error");
            process.exit(1);
          }
          console.log("SUCCESS: Error message contains DATABASE_URL as expected");
        }
      `;
      
      try {
        const result = execSync(`echo '${testScript}' | npx tsx -`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: {
            ...process.env,
            DATABASE_URL: "",  // Missing required var
            DISCORD_BOT_TOKEN: "test-token",
            DISCORD_CHANNEL_ID: "123456789012345678",
          },
        });
        expect(result).toContain("SUCCESS: Error message contains DATABASE_URL as expected");
      } catch (error: any) {
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("SUCCESS: Error message contains DATABASE_URL as expected");
      }
    });
    
    it("should show DISCORD_BOT_TOKEN in error when it's missing", () => {
      const testScript = `
        try {
          await import("${botConfigPath}");
          console.log("ERROR: Should have thrown");
          process.exit(1);
        } catch (error: any) {
          const message = error.message;
          // Should mention DISCORD_BOT_TOKEN
          if (!message.includes("DISCORD_BOT_TOKEN")) {
            console.error("Missing DISCORD_BOT_TOKEN in error");
            process.exit(1);
          }
          console.log("SUCCESS: Error message contains DISCORD_BOT_TOKEN as expected");
        }
      `;
      
      try {
        const result = execSync(`echo '${testScript}' | npx tsx -`, {
          encoding: "utf-8",
          cwd: join(__dirname, "..", ".."),
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://test:test@localhost:5432/test",
            DISCORD_BOT_TOKEN: "",  // Missing required var
            DISCORD_CHANNEL_ID: "123456789012345678",
          },
        });
        expect(result).toContain("SUCCESS: Error message contains DISCORD_BOT_TOKEN as expected");
      } catch (error: any) {
        const output = (error.stderr || "") + (error.stdout || "");
        expect(output).toContain("SUCCESS: Error message contains DISCORD_BOT_TOKEN as expected");
      }
    });
  });
});
