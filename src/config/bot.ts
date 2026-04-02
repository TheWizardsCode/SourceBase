import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

// Bot configuration schema - only includes what the bot actually needs
// CLI-related config has been moved to the openBrain repository
export const botConfigSchema = z.object({
  // Required Discord configuration
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CHANNEL_ID: z.string().min(1, "DISCORD_CHANNEL_ID is required"),
  
  // Optional configuration
  LOG_LEVEL: z.string().optional().default("info"),

  // Summary posting behavior
  SEND_SUMMARY_ON_INSERT: envBoolean.optional().default(true),
  DEFAULT_DISCORD_CHANNEL_ID: z.string().optional(),
  OPENBRAIN_ITEM_URL_TEMPLATE: z.string().optional(),
  
  // File URL configuration
  ALLOWED_FILE_URL_USERS: z.string().optional().transform(v => v ? v.split(',').map(id => id.trim()) : []),
});

const parsed = botConfigSchema.safeParse(process.env);

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
    { name: "DISCORD_BOT_TOKEN", example: "your-bot-token-here", description: "Discord bot authentication token" },
    { name: "DISCORD_CHANNEL_ID", example: "123456789012345678", description: "Discord channel ID for the bot" },
  ];

  let message = "Missing required environment variables:\n\n";

  // Show which specific variables are missing
  const missingVarNames = missingFields
    .filter(field => requiredVars.some(v => field.includes(v.name) || field === v.name))
    .map(field => {
      // Extract just the variable name from error messages like "DISCORD_BOT_TOKEN is required"
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

export const botConfig = parsed.data;
