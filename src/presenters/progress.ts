import type { Message, ThreadChannel } from "discord.js";
import { sendWithFallback } from "./QueuePresenter.js";
import type { AddProgressEvent } from "../bot/cli-runner.js";
import { formatProgressMessage } from "../formatters/progress.js";
import type { Logger } from "../log/index.js";

/**
 * Manages Discord status message lifecycle for CLI progress events.
 *
 * Responsible for:
 * - Formatting progress messages using phase emojis and labels
 * - Tracking posted status messages via a keyed Map
 * - Creating status messages in the appropriate Discord target (thread or channel)
 * - Deduplicating progress updates (only posting when the phase changes)
 * - Suppressing further updates once a terminal phase is observed
 */
export class ProgressPresenter {
  private readonly statusMessages: Map<string, any> = new Map();

  private lastPhase: string | null = null;
  private terminalPhaseSeen = false;
  private lastPostedMessage: any = null;

  constructor(
    private readonly thread: ThreadChannel | null,
    private readonly message: Message,
    private readonly logger: Logger
  ) {}

  /**
   * Handle a CLI progress event, posting a Discord status update if the phase changed.
   *
   * @param event - The progress event from the CLI runner.
   * @returns `true` if a status message was posted, `false` if the event was skipped
   *          (e.g. duplicate phase or post-terminal event).
   */
  async handleProgressEvent(event: AddProgressEvent): Promise<boolean> {
    if (this.terminalPhaseSeen) {
      this.logger.debug("Ignoring CLI progress event after terminal phase", {
        messageId: this.message.id,
        phase: event.phase,
      });
      return false;
    }

    if (event.phase === this.lastPhase) {
      return false;
    }

    this.lastPhase = event.phase ?? null;

    const progressMsg = formatProgressMessage(event);
    const safeProgressMsg = this.makeSafeProgressMsg(event, progressMsg);

    await this.postStatusMessage(event.phase, safeProgressMsg);

    if (event.phase === "completed" || event.phase === "failed") {
      this.terminalPhaseSeen = true;
    }

    return true;
  }

  /**
   * Wrap URLs and titles in backticks so Discord does not create embeds for them.
   */
  private makeSafeProgressMsg(event: AddProgressEvent, progressMsg: string): string {
    try {
      if (event.title) return progressMsg.replace(event.title, `\`${event.title}\``);
      if (event.url) return progressMsg.replace(event.url, `\`${event.url}\``);
      return progressMsg;
    } catch {
      return progressMsg;
    }
  }

  /**
   * Post a status message to the thread (preferred) or channel (fallback).
   * Updates `statusMessages` and `lastPostedMessage` on success.
   */
  private async postStatusMessage(phase: string | undefined, content: string): Promise<void> {
    const key = phase ?? "__unknown__";

    // Use presenters-level sendWithFallback to centralise send/edit/channel.send
    // semantics. The target is thread when present, otherwise fall back to
    // the originating message which exposes reply(). sendWithFallback will
    // attempt send/reply/edit/channel.send in a safe order and log structured
    // warnings on failure.
    try {
      let posted: any = undefined;
      if (this.thread) {
        // First attempt the thread target. If that fails, fall back to the
        // originating message so reply() is attempted (preserves previous
        // fallback behaviour where message.reply() was the secondary path).
        posted = await sendWithFallback(this.thread, content, this.logger, this.lastPostedMessage);
        if (!posted) {
          // Preserve previous logging behaviour for the thread->reply fallback
          // so tests and observability remain stable.
          this.logger.warn(
            "Failed to send progress update to thread; falling back to channel reply",
            {
              threadId: this.thread.id,
              phase,
            }
          );
          posted = await sendWithFallback(this.message, content, this.logger, this.lastPostedMessage);
        }
      } else {
        posted = await sendWithFallback(this.message, content, this.logger, this.lastPostedMessage);
      }

      this.lastPostedMessage = posted ?? this.lastPostedMessage;
      if (posted) this.statusMessages.set(key, posted);
    } catch (err) {
      // In normal operation sendWithFallback never throws - it returns undefined
      // on failure and logs. But be defensive: log any unexpected thrown error.
      this.logger.warn("Unexpected error while sending progress update via sendWithFallback", {
        messageId: this.message.id,
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async appendItemLink(itemLink: string | undefined, itemId: number | undefined, successMsgFallback?: string): Promise<void> {
    if (!itemLink || itemId === undefined) return;
    const appended = `\n\nOpenBrain item: <${itemLink}>\nItem ID: ${itemId}`;

    if (this.lastPostedMessage && typeof this.lastPostedMessage.edit === "function") {
      const prevContent = typeof this.lastPostedMessage.content === "string" ? this.lastPostedMessage.content : (successMsgFallback || "");
      try {
        await this.lastPostedMessage.edit(prevContent + appended);
        return;
      } catch (err) {
        this.logger.warn("Failed to edit completed message with item id", { messageId: this.message.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fallback: use sendWithFallback to post a short item-link message. This
    // will prefer thread send when available or reply otherwise, and will
    // attempt channel.send as a last resort.
    try {
      await sendWithFallback(this.thread ?? this.message, `\u2705 OpenBrain item: <${itemLink}>`, this.logger, this.lastPostedMessage);
    } catch {
      // ignore unexpected throws
    }
  }

  getLastPostedMessage(): any {
    return this.lastPostedMessage;
  }

  getLastPhase(): string | null {
    return this.lastPhase;
  }

  isTerminalPhaseSeen(): boolean {
    return this.terminalPhaseSeen;
  }

  getStatusMessages(): ReadonlyMap<string, any> {
    return this.statusMessages;
  }
}
