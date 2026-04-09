import type { Message } from "discord.js";
import { formatProgressMessage } from "../formatters/progress.js";

/**
 * ProgressPresenter
 *
 * Instance-based presenter that encapsulates per-processing-session state.
 * Responsibilities:
 * - Post progress updates to a ThreadChannel or channel reply
 * - Deduplicate successive events with the same phase
 * - Suppress events after a terminal phase (completed/failed)
 * - Retain the last posted message for the session so callers can append
 *   item links when the CLI returns an ID
 *
 * Public API (instance methods):
 * - handleProgressEvent(event): Promise<boolean>  // posts update if needed
 * - isTerminalPhaseSeen(): boolean
 * - getStatusMessages(): Map<string, any>
 * - getLastPhase(): string | null
 * - getLastPostedMessage(): any | null
 * - postMessage(text): Promise<any>
 * - appendItemLink(itemLink, itemId, successMsgFallback?): Promise<void>
 */
export class ProgressPresenter {
  private thread: any;
  private message: Message;
  private logger: any;
  private statusMessages: Map<string, any> = new Map();
  private lastPhase: string | null = null;
  private lastPostedMessage: any = null;
  private terminal: boolean = false;

  constructor(thread: any, message: Message, logger: any) {
    this.thread = thread;
    this.message = message;
    this.logger = logger;
  }

  isTerminalPhaseSeen(): boolean {
    return this.terminal;
  }

  getStatusMessages(): Map<string, any> {
    return new Map(this.statusMessages);
  }

  getLastPhase(): string | null {
    return this.lastPhase;
  }

  getLastPostedMessage(): any | null {
    return this.lastPostedMessage ?? null;
  }

  /** Post a raw message to the thread or channel and record it as lastPostedMessage */
  async postMessage(text: string): Promise<any> {
    try {
      if (this.thread && typeof this.thread.send === "function") {
        const posted = await this.thread.send(text);
        this.lastPostedMessage = posted ?? this.lastPostedMessage;
        return posted;
      }

      if (this.message && typeof (this.message as any).reply === "function") {
        const posted = await (this.message as any).reply(text);
        this.lastPostedMessage = posted ?? this.lastPostedMessage;
        return posted;
      }
    } catch (err) {
      this.logger?.warn?.("Failed to post message via ProgressPresenter", { error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }

  private safeWrapText(event: any, progressMsg: string): string {
    try {
      if (event.title) return progressMsg.replace(event.title, `\`${event.title}\``);
      if (event.url) return progressMsg.replace(event.url, `\`${event.url}\``);
      return progressMsg;
    } catch {
      return progressMsg;
    }
  }

  /**
   * Handle a CLI progress event. Returns true if a message was posted.
   */
  async handleProgressEvent(event: any): Promise<boolean> {
    // If a terminal phase was already seen, suppress further events
    if (this.terminal) {
      this.logger?.debug?.("Suppressing event after terminal phase", { messageId: this.message?.id, phase: event?.phase });
      return false;
    }

    const phase = typeof event?.phase === "string" && event.phase.trim() !== "" ? event.phase : undefined;
    if (phase !== undefined && phase === this.lastPhase) {
      // deduplicate same-phase events
      return false;
    }

    const progressMsg = formatProgressMessage(event);
    const safeProgressMsg = this.safeWrapText(event, progressMsg);

    // Attempt to post to thread then fallback to reply
    try {
      let posted: any = undefined;
      if (this.thread && typeof this.thread.send === "function") {
        try {
          posted = await this.thread.send(safeProgressMsg);
        } catch (err) {
          this.logger?.warn?.("Failed to send progress update to thread; falling back to channel reply", { threadId: this.thread?.id, phase, error: err instanceof Error ? err.message : String(err) });
          if (this.message && typeof (this.message as any).reply === "function") {
            posted = await (this.message as any).reply(safeProgressMsg);
          }
        }
      } else if (this.message && typeof (this.message as any).reply === "function") {
        posted = await (this.message as any).reply(safeProgressMsg);
      }

      if (posted !== undefined) {
        // Record per-phase posted message for later inspection/edit
        const key = phase ?? `unknown:${Date.now()}`;
        this.statusMessages.set(key, posted);
        this.lastPostedMessage = posted ?? this.lastPostedMessage;
      }
    } catch (err) {
      this.logger?.warn?.("Failed to deliver progress update", { messageId: this.message?.id, phase, error: err instanceof Error ? err.message : String(err) });
    }

    // Mark terminal phases
    try {
      if (event && (event.phase === "completed" || event.phase === "failed")) {
        this.terminal = true;
      }
    } catch {
      // ignore
    }

    this.lastPhase = phase ?? this.lastPhase;
    return true;
  }

  /**
   * Append an item link to the last posted message when possible.
   */
  async appendItemLink(itemLink: string | undefined, itemId: number | undefined, successMsgFallback?: string): Promise<void> {
    if (!itemLink || itemId === undefined) return;
    const appended = `\n\nOpenBrain item: <${itemLink}>\nItem ID: ${itemId}`;

    if (this.lastPostedMessage && typeof this.lastPostedMessage.edit === "function") {
      const prevContent = typeof this.lastPostedMessage.content === "string" ? this.lastPostedMessage.content : (successMsgFallback || "");
      try {
        await this.lastPostedMessage.edit(prevContent + appended);
        return;
      } catch (err) {
        this.logger?.warn?.("Failed to edit completed message with item id", { messageId: this.message?.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fallback: post as a new message to thread or channel
    try {
      if (this.thread && typeof this.thread.send === "function") {
        await this.thread.send(`✅ OpenBrain item: <${itemLink}>`);
      } else if (this.message && typeof (this.message as any).reply === "function") {
        await (this.message as any).reply(`✅ OpenBrain item: <${itemLink}>`);
      }
    } catch {
      // ignore
    }
  }
}
