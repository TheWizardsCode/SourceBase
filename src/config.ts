import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CHANNEL_ID: z.string().min(1, "DISCORD_CHANNEL_ID is required"),
  LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INGEST_FAILURE_REACTION: z.string().min(1).default("⚠️"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export const config = parsed.data;
