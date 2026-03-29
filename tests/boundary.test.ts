import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Boundary Enforcement Tests
 *
 * These tests verify that the bot architectural boundaries are maintained.
 * Note: CLI code has been moved to a separate repository (openBrain).
 */

describe("Bot Boundary Enforcement", () => {
  const srcDir = path.resolve(__dirname, "../src");

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
    it("should have Bot config with Discord dependencies only", () => {
      const botConfigPath = path.join(srcDir, "config/bot.ts");
      const content = fs.readFileSync(botConfigPath, "utf-8");

      // Bot config should include Discord vars
      expect(content).toMatch(/DISCORD_BOT_TOKEN/);
      expect(content).toMatch(/DISCORD_CHANNEL_ID/);

      // Bot config should not import discord.js
      expect(content).not.toMatch(/from\s+["']discord\.js["']/);
    });
  });
});

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
