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
  updateWriteOperation(progress: import('../../../packages/shared/types/write').WriteProgress): Promise<void>;
  claimWriteOperation(claim: import('../../../packages/shared/types/write').WriteClaim): Promise<import('../../../packages/shared/types/write').WriteClaimResult>;
  applyRegistration(command: import('../../../packages/shared/types/registration').RegistrationCommand): Promise<void>;
  projectRealtimeFeed(entry: import('../../../packages/shared/types/realtimeFeed').RealtimeFeedEntry): Promise<void>;
};
