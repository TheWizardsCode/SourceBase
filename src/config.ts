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
  // Summarizer tuning (tokens ~= characters/4)
  SUMMARIZER_MAX_TOKENS: z.coerce.number().int().min(1).default(64000),
  SUMMARIZER_CHUNK_CHARS: z.coerce.number().int().min(1).default(32000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  QDRANT_URL: z.string().url().default("http://127.0.0.1:6333"),
  QDRANT_COLLECTION: z.string().min(1).default("links_vectors"),
  INGEST_SUCCESS_REACTION: z.string().min(1).default("✅"),
  INGEST_FAILURE_REACTION: z.string().min(1).default("⚠️"),
  CRAWL_USER_AGENT: z.string().min(1).default("SourceBaseBot"),
  CRAWL_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export const config = parsed.data;
