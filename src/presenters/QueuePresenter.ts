import type { Logger } from "../log/index.js";

/**
 * QueuePresenter
 *
 * Encapsulates lifecycle management for queue status messages and a small
 * channel-focused cache. This is intentionally lightweight: it provides a
 * single place to reason about creating, updating and clearing short-lived
 * queue status messages in Discord targets (channels or threads).
 */
export class QueuePresenter {
  // Map key -> posted Discord message object
  // Map key -> posted Discord message object or lightweight transport payload
  // We intentionally allow storing either the full Message (runtime) or a
  // transport payload (persisted/minimal shape) to avoid unsafe casting of
  // synthetic objects to the discord.js Message type.
  private readonly queueStatusMessages: Map<string, any> = new Map();

  // Lightweight cache for channel-scoped values (e.g., last known queue position)
  private readonly channelCache: Map<string, unknown> = new Map();

  constructor(private readonly logger?: Logger) {}

  /**
   * Render a simple queue status message body. Kept here so formatting is
   * colocated with the lifecycle logic.
   */
  formatQueueStatusMessage(params: {
    position?: number;
    total?: number;
    processing?: boolean;
    url?: string;
    note?: string;
  }): string {
    const parts: string[] = [];
    if (params.processing) parts.push("🔄 Processing");
    if (typeof params.position === "number") {
      if (typeof params.total === "number") parts.push(`Position ${params.position}/${params.total}`);
      else parts.push(`Position ${params.position}`);
    }
    if (params.url) parts.push(`URL: <${params.url}>`);
    if (params.note) parts.push(params.note);

    if (parts.length === 0) return "Queue status";
    return parts.join(" — ");
  }

  /**
   * Flexible helper that accepts a target which may provide `send()` or
   * `reply()` for posting messages. This keeps callers (message vs thread)
   * interoperable without forcing a strict target type.
   */
  private async postToTarget(target: any, body: string): Promise<any> {
    if (!target) return undefined;
    try {
      // If target is a real runtime object with send/reply, use it.
      if (typeof target.send === "function") return await target.send(body);
      if (typeof target.reply === "function") return await target.reply(body);
      // Fallback: if a channel-like object is provided
      if (target.channel && typeof target.channel.send === "function") return await target.channel.send(body);

      // If the caller provided a lightweight transport payload (for example
      // something persisted from a previous run) we must NOT attempt to cast
      // it to a discord.js Message. Instead, store the payload as-is and
      // treat posting as a no-op. Callers that have runtime access to the
      // Discord client should adapt the payload to a real target and call
      // createOrUpdateStatus with that runtime object. This preserves safety
      // boundaries between persistence and transport.
      if (target && (target.channelId || target.messageId || target.authorId)) {
        this.logger?.debug?.("QueuePresenter.postToTarget: received transport payload; deferring actual posting", { payload: target });
        // Return the payload so it can be stored in the internal map.
        return target;
      }
    } catch (err) {
      this.logger?.warn?.("QueuePresenter.postToTarget failed", { error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }

  /**
   * Attempt to send a message to a target with well-defined fallback order:
   * 1. target.send(body)
   * 2. lastPostedMessage.edit(body) when available
   * 3. target.channel.send(body)
   *
   * Logs a single structured warning when an error occurs and returns the
   * resolved message-like object on success or undefined on failure.
   */
  async sendWithFallback(target: any, body: string, logger?: any, lastPostedMessage?: any): Promise<any> {
    // Attempt each operation independently so a failure in one step doesn't
    // prevent trying the next. Capture the last error so we can emit a single
    // structured warning if everything fails.
    let lastErr: any = null;

    // 1) Prefer explicit target.send
    if (target && typeof target.send === "function") {
      try {
        return await target.send(body);
      } catch (err) {
        lastErr = err;
        // continue to fallbacks
      }
    }

    // 2) If a last posted message is available try edit
    if (lastPostedMessage && typeof lastPostedMessage.edit === "function") {
      try {
        await lastPostedMessage.edit(body);
        return lastPostedMessage;
      } catch (err) {
        lastErr = err;
        // fall through to channel send
      }
    }

    // 3) If the provided target has a channel with send, use it
    if (target && target.channel && typeof target.channel.send === "function") {
      try {
        return await target.channel.send(body);
      } catch (err) {
        lastErr = err;
      }
    }

    // 4) Nothing we can do at runtime - if this is a transport payload defer
    if (target && (target.channelId || target.messageId || target.authorId)) {
      this.logger?.debug?.("QueuePresenter.sendWithFallback: transport payload provided; deferring send", { payload: target });
      return target;
    }

    if (lastErr) {
      const structured = { originalError: lastErr instanceof Error ? lastErr.message : String(lastErr), targetId: target?.id ?? target?.channelId ?? null };
      (logger ?? this.logger)?.warn?.("sendWithFallback failed", structured);
    }

    return undefined;
  }

  /**
   * Create or update a status message keyed by `key` in the provided target.
   * The `target` may expose `send(content)` or `reply(content)` which resolves
   * to a message object; if the previously-posted message supports `edit()`
   * it will be used for updates to avoid clutter.
   */
  async createOrUpdateStatus(key: string, target: any, body: string): Promise<any> {
    const existing = this.queueStatusMessages.get(key);
    try {
      if (existing && typeof existing.edit === "function") {
        await existing.edit(body);
        this.logger?.debug?.("QueuePresenter: edited existing status message", { key });
        return existing;
      }

      const posted = await this.postToTarget(target, body);
      this.queueStatusMessages.set(key, posted ?? null);
      this.logger?.debug?.("QueuePresenter: posted new status message", { key });
      return posted;
    } catch (err) {
      this.logger?.warn?.("QueuePresenter: failed to post/update status message", { key, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /**
   * Remove a status message (if present). If the message exposes `delete()`
   * it will be called; otherwise we attempt to edit the message to indicate
   * removal. Finally the internal map entry is removed.
   */
  async clearStatus(key: string): Promise<void> {
    const existing = this.queueStatusMessages.get(key);
    if (!existing) return;
    try {
      if (typeof existing.delete === "function") {
        await existing.delete();
      } else if (typeof existing.edit === "function") {
        // Clear the content as a best-effort fallback
        await existing.edit("(removed)");
      }
    } catch (err) {
      this.logger?.warn?.("QueuePresenter: failed to remove status message", { key, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.queueStatusMessages.delete(key);
    }
  }

  /**
   * Return the stored message instance for a key, if any.
   */
  getStatusMessage(key: string): any {
    return this.queueStatusMessages.get(key);
  }

  /**
   * Channel cache helpers
   */
  setChannelCache(channelId: string, value: unknown): void {
    this.channelCache.set(channelId, value);
  }

  getChannelCache(channelId: string): unknown | undefined {
    return this.channelCache.get(channelId);
  }

  clearChannelCache(channelId: string): void {
    this.channelCache.delete(channelId);
  }

  /**
   * Clear all tracked messages and cache (useful during shutdown/test cleanup).
   */
  async clearAll(): Promise<void> {
    const keys = Array.from(this.queueStatusMessages.keys());
    await Promise.all(keys.map((k) => this.clearStatus(k)));
    this.channelCache.clear();
  }
}

export default QueuePresenter;

/**
 * Convenience top-level helper that mirrors QueuePresenter.sendWithFallback semantics
 * without requiring callers to hold a presenter instance. It creates a short-lived
 * QueuePresenter for the purpose of sending and delegates logging to the provided
 * logger when given.
 */
export async function sendWithFallback(target: any, body: string, logger?: any, lastPostedMessage?: any): Promise<any> {
  const qp = new QueuePresenter(logger);
  return qp.sendWithFallback(target, body, logger, lastPostedMessage);
}

/**
 * Minimal transport payload representing persisted queue context.
 * This is intentionally small and independent of discord.js runtime types.
 */
export interface QueueTransportPayload {
  channelId?: string;
  messageId?: string;
  authorId?: string;
}

// Backwards-compatible formatting helpers moved from presenters/queue.ts
export function formatMissingCrawlSeedMessage(): string {
  return "Please pass a seed URL to crawl, for example: `crawl https://example.com`.";
}

export function formatQueuedUrlMessage(seed: string): string {
  return `Queued URL for crawling: \`${seed}\``;
}

export function formatQueueFailureMessage(error: string | undefined, fallbackError: string): string {
  return `Failed to queue URL\n\n${error || fallbackError}`;
}
