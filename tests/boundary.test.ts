import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Boundary Enforcement Tests
 *
 * These tests verify that the CLI/bot architectural boundary is maintained:
 * 1. CLI code must not import discord.js
 * 2. CLI code must not reference DISCORD_* environment variables
 * 3. Bot code should not directly import CLI command modules
 */

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("CLI/Bot Boundary Enforcement", () => {
  const srcDir = path.resolve(__dirname, "../src");
  const cliDir = path.join(srcDir, "cli");

  describe("CLI Boundary Rules", () => {
    it("should have no discord.js imports in src/cli/**", () => {
      const cliFiles = getAllTsFiles(cliDir);
      const violations: string[] = [];

      for (const file of cliFiles) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for discord.js imports (not type-only)
          if (/^import\s+.*from\s+["']discord\.js["']/.test(line)) {
            violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
          }
          // Check for namespace imports
          if (/^import\s+\*\s+as\s+.*from\s+["']discord\.js["']/.test(line)) {
            violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(violations, `Found discord.js imports in CLI code:\n${violations.join("\n")}`).toHaveLength(0);
    });

    it("should have no DISCORD_* env var references in src/cli/**", () => {
      const cliFiles = getAllTsFiles(cliDir);
      const violations: string[] = [];

      for (const file of cliFiles) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for DISCORD_ env var references (excluding comments and imports)
          if (/DISCORD_[A-Z_]+/.test(line) && !line.includes("//") && !line.includes("import")) {
            violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(violations, `Found DISCORD_* references in CLI code:\n${violations.join("\n")}`).toHaveLength(0);
    });

    it("should have no bot module imports in src/cli/**", () => {
      const cliFiles = getAllTsFiles(cliDir);
      const violations: string[] = [];

      for (const file of cliFiles) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for imports from bot/ modules
          if (/from\s+["']\.\.\/bot\//.test(line) || /from\s+["']\.\.\.\/bot\//.test(line)) {
            violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(violations, `Found bot module imports in CLI code:\n${violations.join("\n")}`).toHaveLength(0);
    });
  });

  describe("Bot Boundary Rules", () => {
    it("should not directly import CLI command modules from bot code", () => {
      const botDir = path.join(srcDir, "bot");
      const botFiles = fs.existsSync(botDir) ? getAllTsFiles(botDir) : [];
      // Also check src/index.ts
      const indexFile = path.join(srcDir, "index.ts");
      if (fs.existsSync(indexFile)) {
        botFiles.push(indexFile);
      }
      const violations: string[] = [];

      for (const file of botFiles) {
        // Skip cli-runner.ts (it's allowed to spawn CLI)
        if (file.includes("cli-runner.ts")) continue;

        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for direct CLI command imports (not allowed)
          // Type-only imports are allowed (import type { ... })
          if (/^import\s+(?!type\s+).*from\s+["']\.\.\/cli\/commands\//.test(line)) {
            violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(violations, `Found direct CLI command imports in bot code:\n${violations.join("\n")}`).toHaveLength(0);
    });
  });

  describe("Config Boundary", () => {
    it("should have CLI config without Discord dependencies", () => {
      const cliConfigPath = path.join(srcDir, "config/cli.ts");
      const content = fs.readFileSync(cliConfigPath, "utf-8");

      // CLI config should not reference DISCORD_*
      expect(content).not.toMatch(/DISCORD_[A-Z_]+/);

      // CLI config should not import discord.js
      expect(content).not.toMatch(/from\s+["']discord\.js["']/);
    });

    it("should have Bot config extending CLI config", () => {
      const botConfigPath = path.join(srcDir, "config/bot.ts");
      const content = fs.readFileSync(botConfigPath, "utf-8");

      // Bot config should import from CLI config
      expect(content).toMatch(/from\s+["']\.\.?\/cli\.js["']/);

      // Bot config should extend CLI schema
      expect(content).toMatch(/cliConfigSchema\.extend/);

      // Bot config should include Discord vars
      expect(content).toMatch(/DISCORD_BOT_TOKEN/);
      expect(content).toMatch(/DISCORD_CHANNEL_ID/);
    });
  });
});
