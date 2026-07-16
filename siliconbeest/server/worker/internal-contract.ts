export type StreamEventPayload = {
  /** Mastodon event type: update, notification, delete, status.update, filters_changed */
  event: string;
  /** JSON-stringified payload */
  payload: string;
  /** Target stream names (e.g. ["user", "user:notification"]) */
  stream?: string[];
};

export type InternalRpc = {
  sendStreamEvent(userId: string, event: StreamEventPayload): Promise<void>;
};
