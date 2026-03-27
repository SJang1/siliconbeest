-- Status mutes: allows users to mute notifications from specific statuses
CREATE TABLE IF NOT EXISTS status_mutes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status_id TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, status_id)
);

CREATE INDEX IF NOT EXISTS idx_status_mutes_account ON status_mutes(account_id);
CREATE INDEX IF NOT EXISTS idx_status_mutes_status ON status_mutes(status_id);
