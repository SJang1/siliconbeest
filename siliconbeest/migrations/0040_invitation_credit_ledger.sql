-- Invitation credit balances, contribution awards, and immutable audit history.

CREATE TABLE account_invitation_balances (
  account_id                TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  available_credits         INTEGER NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
  contribution_score        INTEGER NOT NULL DEFAULT 0,
  contribution_award_level  INTEGER NOT NULL DEFAULT 0 CHECK (contribution_award_level >= 0),
  last_operation_id         TEXT,
  last_credit_delta         INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

INSERT INTO account_invitation_balances
  (account_id, available_credits, contribution_score, contribution_award_level,
   last_operation_id, last_credit_delta, created_at, updated_at)
SELECT accounts.id, 0, 0, 0, NULL, 0, datetime('now'), datetime('now')
FROM accounts
JOIN users ON users.account_id = accounts.id
WHERE accounts.domain IS NULL;

CREATE TABLE invitation_audit_logs (
  id                       TEXT PRIMARY KEY,
  actor_account_id         TEXT,
  target_account_id        TEXT,
  invitation_id            TEXT,
  action                   TEXT NOT NULL,
  credit_delta             INTEGER NOT NULL DEFAULT 0,
  contribution_delta       INTEGER NOT NULL DEFAULT 0,
  credits_after            INTEGER,
  contribution_score_after INTEGER,
  metadata                 TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL
);

CREATE INDEX idx_invitation_audit_logs_created_at
  ON invitation_audit_logs(created_at DESC, id DESC);

CREATE INDEX idx_invitation_audit_logs_target_account
  ON invitation_audit_logs(target_account_id, created_at DESC);

CREATE INDEX idx_invitation_audit_logs_invitation
  ON invitation_audit_logs(invitation_id, created_at DESC);

-- A revoked link returns its unused credits, so issuing and revoking could
-- otherwise be repeated without consuming balance while growing permanent
-- audit and tombstone data. This account-scoped window bounds that growth.
CREATE TABLE invitation_link_issue_limits (
  account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  window_started_at TEXT NOT NULL,
  issued_links      INTEGER NOT NULL CHECK (issued_links >= 0),
  last_operation_id TEXT
);

-- Successful consume transitions are account-scoped and bounded. Since every
-- cancellation can only restore a previously consumed use, this also bounds
-- consume/cancel audit churn without ever refusing an owed refund.
CREATE TABLE invitation_use_daily_limits (
  account_id        TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  window_started_at TEXT NOT NULL,
  consumed_uses     INTEGER NOT NULL CHECK (consumed_uses >= 0),
  last_operation_id TEXT
);

-- One row represents one consumed use until that use is either assigned to a
-- pending registration, restored, or finalized by activation. Counting these
-- rows closes the consume-to-user capacity gap and makes concurrent consumes
-- independently restorable.
CREATE TABLE invitation_use_claims (
  id                 TEXT PRIMARY KEY,
  invitation_id      TEXT NOT NULL REFERENCES registration_invites(id) ON DELETE CASCADE,
  inviter_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  assigned_user_id   TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  claimed_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL
);

CREATE INDEX idx_invitation_use_claims_inviter
  ON invitation_use_claims(inviter_account_id);
CREATE INDEX idx_invitation_use_claims_expiry
  ON invitation_use_claims(expires_at);

INSERT INTO invitation_use_claims
  (id, invitation_id, inviter_account_id, assigned_user_id, claimed_at, expires_at)
SELECT lower(hex(randomblob(16))), users.invite_id, users.invited_by_account_id,
       users.id, users.created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ', users.created_at, '+30 days')
FROM users
WHERE users.invite_id IS NOT NULL
  AND users.invited_by_account_id IS NOT NULL
  AND (users.registration_state != 'active' OR users.approved = 0);

ALTER TABLE registration_invites ADD COLUMN issued_uses INTEGER NOT NULL DEFAULT 0
  CHECK (issued_uses >= 0);
ALTER TABLE registration_invites ADD COLUMN revoked_unused_uses INTEGER NOT NULL DEFAULT 0
  CHECK (revoked_unused_uses >= 0);
ALTER TABLE registration_invites ADD COLUMN credits_restored_at TEXT;
ALTER TABLE registration_invites ADD COLUMN credit_operation_id TEXT;
-- Marks links whose unused uses were deliberately destroyed by an
-- administrator reset. Already-consumed claims remain refundable on signup
-- cancellation, as required by the invitation contract.
ALTER TABLE registration_invites ADD COLUMN reset_at TEXT;

UPDATE registration_invites
SET issued_uses = remaining_uses;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('invite_credit_max_per_account', '999', datetime('now')),
  ('invite_link_issuance_enabled', '1', datetime('now')),
  ('invite_contribution_enabled', '0', datetime('now')),
  ('invite_contribution_threshold', '100', datetime('now')),
  ('invite_contribution_points_status_create', '0', datetime('now')),
  ('invite_contribution_points_reply_create', '0', datetime('now')),
  ('invite_contribution_points_status_delete', '0', datetime('now')),
  ('invite_contribution_points_status_reblog', '0', datetime('now')),
  ('invite_contribution_points_status_unreblog', '0', datetime('now')),
  ('invite_contribution_points_status_favourite', '0', datetime('now')),
  ('invite_contribution_points_status_unfavourite', '0', datetime('now')),
  ('invite_contribution_points_account_follow', '0', datetime('now')),
  ('invite_contribution_points_account_unfollow', '0', datetime('now')),
  ('invite_contribution_points_poll_vote', '0', datetime('now')),
  ('invite_contribution_points_media_upload', '0', datetime('now')),
  ('invite_contribution_points_status_bookmark', '0', datetime('now')),
  ('invite_contribution_points_status_unbookmark', '0', datetime('now')),
  ('invite_contribution_points_profile_update', '0', datetime('now')),
  ('invite_contribution_points_report_submit', '0', datetime('now')),
  ('invite_contribution_points_list_create', '0', datetime('now')),
  ('invite_contribution_points_list_delete', '0', datetime('now')),
  ('invite_contribution_points_generic_mutation', '0', datetime('now'));
