import { PermissionFlagsBits, type Message, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import type { Logger } from "../log/index.js";
import { sendWithFallback } from "../presenters/QueuePresenter.js";

/**
 * User-facing error message for CLI unavailability
 */
export const CLI_UNAVAILABLE_MESSAGE =
  "⚠️ OpenBrain CLI is not available. Please ensure the CLI is installed and accessible on PATH.";

/**
 * Message reaction emojis
 */
export const PROCESSING_REACTION = "👀";
export const SUCCESS_REACTION = "✅";
export const FAILURE_REACTION = "⚠️";

/**
 * Retry configuration for summary generation
 */
export const SUMMARY_RETRY_ATTEMPTS = 3;
export const SUMMARY_RETRY_BASE_DELAY_MS =
  process.env.NODE_ENV === "test" ? 1 : 500;

/**
 * Type guard for chat input command interactions
 */
export function isChatInputInteraction(
  interaction: Interaction
): interaction is ChatInputCommandInteraction {
  const maybe = interaction as unknown as {
    isChatInputCommand?: () => boolean;
    isCommand?: () => boolean;
  };

  if (typeof maybe.isChatInputCommand === "function") {
    return maybe.isChatInputCommand();
  }

  if (typeof maybe.isCommand === "function") {
    return maybe.isCommand();
  }

  return false;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Add a reaction to a message
 */
export async function addReaction(
  message: Message,
  emoji: string,
  logger?: Logger
): Promise<void> {
  try {
    await message.react(emoji);
  } catch (error) {
    logger?.warn("Failed to add reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remove a reaction from a message (removes bot's reaction only)
 */
export async function removeReaction(
  message: Message,
  emoji: string,
  logger?: Logger
): Promise<void> {
  try {
    const botUserId = message.client?.user?.id;
    if (!botUserId) return;

    // Get the reaction and remove the bot's reaction
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(botUserId);
    }
  } catch (error) {
    logger?.warn("Failed to remove reaction", {
      messageId: message.id,
      emoji,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Suppress embeds on a message if the bot has the MANAGE_MESSAGES permission.
 * Returns true if suppression was attempted and succeeded, false otherwise.
 */
export async function suppressEmbedsIfPermitted(
  message: Message,
  logger?: Logger
): Promise<boolean> {
  try {
    const guild = message.guild;
    if (!guild) {
      logger?.debug("Message not in a guild; cannot suppress embeds", {
        messageId: message.id,
      });
      return false;
    }

    const botUserId = message.client?.user?.id;
    if (!botUserId) {
      logger?.warn("Could not determine bot user id for permission check", {
        messageId: message.id,
      });
      return false;
    }

    // Fetch the bot's guild member to get up-to-date permissions
    const botMember = await guild.members.fetch(botUserId);
    if (!botMember) {
      logger?.warn("Failed to fetch bot guild member", {
        messageId: message.id,
      });
      return false;
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ManageMessages)) {
      logger?.warn("Bot lacks MANAGE_MESSAGES permission; cannot suppress embeds", {
        messageId: message.id,
      });
      return false;
    }

    // Call suppressEmbeds if available on this Message object
    const suppressFn = (message as any).suppressEmbeds;
    if (typeof suppressFn === "function") {
      await suppressFn.call(message, true);
      logger?.debug("Suppressed embeds on message", { messageId: message.id });
      return true;
    }

    logger?.warn("suppressEmbeds method not available on message object", {
      messageId: message.id,
    });
    return false;
  } catch (err) {
    logger?.warn("Error while attempting to suppress embeds", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Check if CLI is available and reply with error message if not
 * @returns true if CLI is available, false otherwise
 */
export async function checkCliAvailability(
  message: Message,
  isCliAvailable: () => Promise<boolean>,
  logger?: Logger
): Promise<boolean> {
  logger?.debug("Checking CLI availability...", { messageId: message.id });

  try {
    const isAvailable = await Promise.race([
      isCliAvailable(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("CLI check timeout")), 10000)
      ),
    ]);

    if (!isAvailable) {
      logger?.warn("CLI availability check failed - CLI not found", {
        messageId: message.id,
        channelId: message.channelId,
      });
      await sendWithFallback(message, CLI_UNAVAILABLE_MESSAGE, logger);
      return false;
    }

    logger?.debug("CLI is available", { messageId: message.id });
    return true;
  } catch (error) {
    logger?.error("CLI availability check error", {
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await sendWithFallback(message, CLI_UNAVAILABLE_MESSAGE, logger);
    return false;
  }
}
