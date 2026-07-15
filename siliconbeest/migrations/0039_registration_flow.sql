-- Registration lifecycle, referral invites, and email verification state.

CREATE TABLE registration_invites (
  id                 TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL,
  inviter_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remaining_uses     INTEGER NOT NULL DEFAULT 1 CHECK (remaining_uses >= 0),
  auto_follow        INTEGER NOT NULL DEFAULT 1 CHECK (auto_follow IN (0, 1)),
  expires_at         TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_registration_invites_token_hash
  ON registration_invites(token_hash);

CREATE INDEX idx_registration_invites_inviter_account_id
  ON registration_invites(inviter_account_id);

ALTER TABLE users ADD COLUMN registration_state TEXT NOT NULL DEFAULT 'active'
  CHECK (registration_state IN (
    'pending_approval',
    'awaiting_confirmation',
    'email_verification',
    'active'
  ));
ALTER TABLE users ADD COLUMN invite_id TEXT
  REFERENCES registration_invites(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN invited_by_account_id TEXT
  REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN registration_redirect_uri TEXT;
ALTER TABLE users ADD COLUMN registration_design TEXT NOT NULL DEFAULT 'default'
  CHECK (registration_design IN ('default', 'aurora', 'old'));
ALTER TABLE users ADD COLUMN email_verification_code_hash TEXT;
ALTER TABLE users ADD COLUMN email_verification_sent_at TEXT;
ALTER TABLE users ADD COLUMN email_verification_expires_at TEXT;
ALTER TABLE users ADD COLUMN email_verification_attempts INTEGER NOT NULL DEFAULT 0;

-- Preserve the lifecycle of accounts that were already waiting under the
-- legacy confirmation/approval flow when this migration is deployed.
UPDATE users
SET registration_state = CASE
  WHEN approved = 0 THEN 'pending_approval'
  WHEN confirmed_at IS NULL THEN 'awaiting_confirmation'
  ELSE 'active'
END;

-- Legacy open registrations were marked approved and discoverable before
-- their email was confirmed. Keep every incomplete account private while it
-- moves through the new lifecycle.
UPDATE users
SET approved = 0
WHERE registration_state != 'active';

UPDATE accounts
SET discoverable = 0
WHERE id IN (
  SELECT account_id
  FROM users
  WHERE registration_state != 'active'
);

CREATE INDEX idx_users_registration_state ON users(registration_state);
CREATE INDEX idx_users_invite_id ON users(invite_id);
CREATE INDEX idx_users_invited_by_account_id ON users(invited_by_account_id);

-- Confirmation links exchange a short-lived, user-bound ticket on the
-- registration completion page. Keeping the consumed marker in D1 makes the
-- exchange atomic even when the browser submits the ticket concurrently.
CREATE TABLE registration_completion_tickets (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  design       TEXT NOT NULL CHECK (design IN ('default', 'aurora', 'old')),
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_registration_completion_tickets_expiry
  ON registration_completion_tickets(expires_at);

-- Persistent, privacy-preserving per-address delivery limits keep confirmation
-- resends bounded across Worker isolates and pending-account cancellation. The
-- rolling window and last-sent timestamp are claimed before a new challenge is
-- generated, so parallel requests cannot fan out multiple emails.
CREATE TABLE registration_email_delivery_limits (
  email_hash        TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  send_count        INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  last_sent_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('require_email_verification', '1', datetime('now'));
