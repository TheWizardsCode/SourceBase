import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CHANNEL_ID: z.string().min(1, "DISCORD_CHANNEL_ID is required"),
  LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  LLM_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(250),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INGEST_SUCCESS_REACTION: z.string().min(1).default("✅"),
  INGEST_FAILURE_REACTION: z.string().min(1).default("⚠️"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // YouTube configuration
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_CAPTION_LANGUAGE: z.string().default("en"),
  ENABLE_YOUTUBE_CAPTIONS: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  // Backfill configuration
  BACKFILL_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000), // 1 hour default
  MAX_BACKFILL_ATTEMPTS: z.coerce.number().int().min(1).default(3)
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export const config = parsed.data;
