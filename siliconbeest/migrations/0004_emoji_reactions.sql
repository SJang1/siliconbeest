CREATE TABLE IF NOT EXISTS emoji_reactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status_id TEXT NOT NULL REFERENCES statuses(id),
  emoji TEXT NOT NULL,
  custom_emoji_id TEXT REFERENCES custom_emojis(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, status_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_emoji_reactions_status ON emoji_reactions(status_id);
CREATE INDEX IF NOT EXISTS idx_emoji_reactions_account ON emoji_reactions(account_id);
