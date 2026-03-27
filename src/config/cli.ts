import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const cliConfigSchema = z.object({
  LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  // Optional: separate model name to use for embeddings (e.g. "embed")
  LLM_EMBEDDING_MODEL: z.string().optional(),
  // Embedding batch size (number of items to send per batch when supported)
  LLM_EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).default(2048),
  // Max characters per embed chunk — must stay within the embedding proxy's token limit
  LLM_EMBEDDING_MAX_CHARS: z.coerce.number().int().min(100).default(1100),
  // Embedding model output dimension (must match the model's native output, e.g. 1024 for mxbai-embed-large-v1)
  LLM_EMBEDDING_DIM: z.coerce.number().int().min(1).default(1024),
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
  INGEST_UPDATE_REACTION: z.string().min(1).default("🔄"),
  CRAWL_USER_AGENT: z.string().min(1).default("SourceBaseBot"),
  CRAWL_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // YouTube configuration
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_CAPTION_LANGUAGE: z.string().default("en"),
  ENABLE_YOUTUBE_CAPTIONS: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
});

const parsed = cliConfigSchema.safeParse(process.env);

if (!parsed.success) {
  // Extract field names from validation errors for better messaging
  const missingFields = parsed.error.issues
    .filter((issue) => issue.message.includes("required") || issue.code === "invalid_type")
    .map((issue) => {
      const path = issue.path.join(".");
      return path || issue.message;
    });

  const errorMessage = formatConfigError(missingFields);
  throw new Error(errorMessage);
}

function formatConfigError(missingFields: string[]): string {
  const requiredVars = [
    { name: "DATABASE_URL", example: "postgresql://user:pass@localhost:5432/dbname", description: "PostgreSQL connection string" },
    { name: "LLM_BASE_URL", example: "http://localhost:8080/v1", description: "LLM API base URL" },
    { name: "LLM_MODEL", example: "gpt-4o-mini", description: "LLM model name" }
  ];

  let message = "Missing required environment variables:\n\n";

  // Show which specific variables are missing
  const missingVarNames = missingFields
    .filter(field => requiredVars.some(v => field.includes(v.name) || field === v.name))
    .map(field => {
      // Extract just the variable name from error messages like "DATABASE_URL is required"
      const match = field.match(/^[A-Z_]+/);
      return match ? match[0] : field;
    });

  if (missingVarNames.length === 0) {
    // If we can't parse the field names, show all requirements
    missingVarNames.push(...requiredVars.map(v => v.name));
  }

  // Remove duplicates
  const uniqueMissing = [...new Set(missingVarNames)];

  uniqueMissing.forEach(varName => {
    const info = requiredVars.find(v => v.name === varName);
    if (info) {
      message += `  ${info.name}\n    Description: ${info.description}\n    Example: ${info.example}\n\n`;
    } else {
      message += `  ${varName}\n`;
    }
  });

  message += "\nTo fix this, you can either:\n\n";
  message += "1. Set environment variables directly:\n";
  requiredVars.forEach(info => {
    if (uniqueMissing.includes(info.name)) {
      message += `   export ${info.name}="${info.example}"\n`;
    }
  });
  message += "\n2. Create a .env file in the project root with:\n";
  requiredVars.forEach(info => {
    if (uniqueMissing.includes(info.name)) {
      message += `${info.name}=${info.example}\n`;
    }
  });
  message += "\n3. Copy .env.example to .env and edit the values\n";

  return message;
}

export const cliConfig = parsed.data;
