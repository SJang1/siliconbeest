CREATE TABLE IF NOT EXISTS shard_metadata (family TEXT NOT NULL CHECK (family = 'REMOTE_ACTORS'), schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (family, schema_version));
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('REMOTE_ACTORS', 1);
CREATE TABLE IF NOT EXISTS remote_actor_records (id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, payload_json TEXT NOT NULL, fetched_at TEXT, updated_at TEXT NOT NULL);
