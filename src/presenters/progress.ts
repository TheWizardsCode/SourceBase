import type { Message, ThreadChannel } from "discord.js";
import type { AddProgressEvent } from "../bot/cli-runner.js";
import { formatProgressMessage } from "../formatters/progress.js";
import type { Logger } from "../logger.js";

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

    if (this.thread) {
      try {
        const posted = await this.thread.send(content);
        this.lastPostedMessage = posted ?? this.lastPostedMessage;
        if (posted) this.statusMessages.set(key, posted);
      } catch (error) {
        this.logger.warn(
          "Failed to send progress update to thread; falling back to channel reply",
          {
            threadId: this.thread.id,
            phase,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        try {
          const posted = await this.message.reply(content);
          this.lastPostedMessage = posted ?? this.lastPostedMessage;
          if (posted) this.statusMessages.set(key, posted);
        } catch (err) {
          this.logger.warn("Failed to send fallback progress reply to channel", {
            messageId: this.message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      try {
        const posted = await this.message.reply(content);
        this.lastPostedMessage = posted ?? this.lastPostedMessage;
        if (posted) this.statusMessages.set(key, posted);
      } catch (err) {
        this.logger.warn("Failed to send progress update to channel", {
          messageId: this.message.id,
          phase,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

    try {
      if (this.thread && typeof this.thread.send === "function") {
        await this.thread.send(`\u2705 OpenBrain item: <${itemLink}>`);
      } else if (this.message && typeof (this.message as any).reply === "function") {
        await (this.message as any).reply(`\u2705 OpenBrain item: <${itemLink}>`);
      }
    } catch {
      // ignore
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
