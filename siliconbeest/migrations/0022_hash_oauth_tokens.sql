-- Add token_hash column for SHA-256 hashed token storage.
ALTER TABLE oauth_access_tokens ADD COLUMN token_hash TEXT;

-- Index for fast lookups by hash
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_token_hash ON oauth_access_tokens(token_hash);

-- SQLite cannot ALTER COLUMN to remove NOT NULL, so we recreate the table.
-- This preserves all existing data while making the token column nullable.
CREATE TABLE oauth_access_tokens_new (
  id              TEXT PRIMARY KEY,
  token           TEXT,
  token_hash      TEXT,
  refresh_token   TEXT UNIQUE,
  application_id  TEXT NOT NULL REFERENCES oauth_applications(id),
  user_id         TEXT REFERENCES users(id),
  scopes          TEXT NOT NULL,
  expires_at      TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);

INSERT INTO oauth_access_tokens_new SELECT id, token, token_hash, refresh_token, application_id, user_id, scopes, expires_at, revoked_at, created_at FROM oauth_access_tokens;

DROP TABLE oauth_access_tokens;

ALTER TABLE oauth_access_tokens_new RENAME TO oauth_access_tokens;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token ON oauth_access_tokens(token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token_hash ON oauth_access_tokens(token_hash);
