-- Privacy-preserving cooldowns for user-cancelled registrations. Keeping only
-- the normalized email hash lets the restriction survive pending-account
-- deletion without retaining the cancelled address itself.
CREATE TABLE registration_cancellation_cooldowns (
  email_hash   TEXT PRIMARY KEY,
  cancelled_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_registration_cancellation_cooldowns_expiry
  ON registration_cancellation_cooldowns(expires_at);
