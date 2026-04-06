/**
 * Streaming service helper.
 *
 * Used by the queue consumer (and other internal callers) to push events
 * into a user's StreamingDO instance, which then broadcasts to all
 * connected WebSocket clients.
 */

import { env } from 'cloudflare:workers';
export type StreamEventPayload = {
  /** Mastodon event type: update, notification, delete, status.update, filters_changed */
  event: string;
  /** JSON-stringified payload */
  payload: string;
  /** Target stream names (e.g. ["user", "user:notification"]) */
  stream?: string[];
};

/**
 * Send an event to a user's StreamingDO instance.
 *
 * @param userId       The user ID (used as DO name)
 * @param event        The event to broadcast
 */
export async function sendStreamEvent(
  userId: string,
  event: StreamEventPayload,
): Promise<void> {
  const doId = env.STREAMING_DO.idFromName(userId);
  const stub = env.STREAMING_DO.get(doId);

  await stub.fetch('https://streaming/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}
