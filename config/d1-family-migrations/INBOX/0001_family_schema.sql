CREATE TABLE IF NOT EXISTS shard_metadata (family TEXT NOT NULL CHECK (family = 'INBOX'), schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (family, schema_version));
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('INBOX', 1);
CREATE TABLE IF NOT EXISTS inbox_entries (id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, entry_type TEXT NOT NULL, payload_json TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inbox_entries_owner_created ON inbox_entries (owner_account_id, created_at DESC);
