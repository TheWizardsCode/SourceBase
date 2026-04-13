import type { Client, TextChannel } from "discord.js";
import type { QueueTransportPayload } from "./QueuePresenter.js";
import { sendWithFallback as sendWithFallbackFromPresenter } from "./QueuePresenter.js";

/**
 * SendableTarget is the minimal runtime shape QueuePresenter expects for
 * posting messages: it has an id and a send(content) method.
 */
export type SendableTarget = { id: string; send: (content: string) => Promise<any> };

/**
 * Try to resolve a QueueTransportPayload to a runtime SendableTarget using
 * the provided Discord client. Returns null if resolution is not possible.
 *
 * This is intentionally best-effort: callers should handle null and provide
 * fallback behaviour (for example, posting to a configured default channel
 * or deferring until a client is available).
 */
export async function resolveTransportPayloadToTarget(
  client: Client,
  payload: QueueTransportPayload
): Promise<SendableTarget | null> {
  if (!client || !payload) return null;

  // Prefer resolving a channel if we have channelId. We return a small adapter
  // that exposes send(content) so it can be used interchangeably with Message
  // targets in presenters.
  if (payload.channelId) {
    try {
      const ch = await client.channels.fetch(payload.channelId);
      if (ch && (ch as any).send && typeof (ch as any).send === "function") {
        const channel = ch as unknown as TextChannel;
        return { id: payload.channelId, send: (content: string) => channel.send(content) };
      }
    } catch {
      // ignore resolution errors and continue to next option
    }
  }

  // If we have a messageId and channelId both, try to fetch the message and
  // return an adapter that calls message.reply(). This is a helpful fallback
  // for recreating the original posting context when possible.
  if (payload.channelId && payload.messageId) {
    try {
      const ch = await client.channels.fetch(payload.channelId);
      if (ch && (ch as any).messages && typeof (ch as any).messages.fetch === "function") {
        const messages = (ch as any).messages as { fetch: (id: string) => Promise<any> };
        const msg = await messages.fetch(payload.messageId);
        if (msg && typeof msg.reply === "function") {
          return { id: payload.messageId, send: (content: string) => msg.reply(content) };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export default resolveTransportPayloadToTarget;

/**
 * Small adapter that attempts to send content to a resolved target using the
 * presenters-layer sendWithFallback semantics. This keeps caller code uniform
 * when operating on resolved transport payloads.
 */
export async function sendWithFallbackToResolvedTarget(
  target: SendableTarget | null | undefined,
  body: string,
  logger?: any,
  lastPostedMessage?: any
): Promise<any> {
  return await sendWithFallbackFromPresenter(target, body, logger, lastPostedMessage);
}
