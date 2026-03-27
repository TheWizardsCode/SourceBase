import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI tests invoke external commands that may need to wait for
    // connection timeouts (database, LLM services), so use a longer timeout
    testTimeout: 15000,
    // Allow tests to run longer in CI environments
    hookTimeout: 10000,
    // Provide default environment variables for tests
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_CHANNEL_ID: "test-channel",
      LLM_BASE_URL: "http://localhost:8080",
      LLM_MODEL: "test-model",
    },
  },
});
