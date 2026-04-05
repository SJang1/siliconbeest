/**
 * Streaming service helper.
 *
 * Used by the queue consumer (and other internal callers) to push events
 * into a user's StreamingDO instance, which then broadcasts to all
 * connected WebSocket clients.
 */

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
 * @param doNamespace  The STREAMING_DO binding from Env
 * @param userId       The user ID (used as DO name)
 * @param event        The event to broadcast
 */
export async function sendStreamEvent(
  doNamespace: DurableObjectNamespace,
  userId: string,
  event: StreamEventPayload,
): Promise<void> {
  const doId = doNamespace.idFromName(userId);
  const stub = doNamespace.get(doId);

  await stub.fetch('https://streaming/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}
