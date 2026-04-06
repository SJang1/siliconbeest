-- Add session tracking columns to oauth_access_tokens
ALTER TABLE oauth_access_tokens ADD COLUMN ip TEXT;
ALTER TABLE oauth_access_tokens ADD COLUMN user_agent TEXT;
ALTER TABLE oauth_access_tokens ADD COLUMN last_used_at TEXT;
