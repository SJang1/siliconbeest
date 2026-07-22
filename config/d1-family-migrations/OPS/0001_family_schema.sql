CREATE TABLE IF NOT EXISTS shard_metadata (family TEXT NOT NULL CHECK (family = 'OPS'), schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (family, schema_version));
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('OPS', 1);
CREATE TABLE IF NOT EXISTS operation_audit (operation_id TEXT PRIMARY KEY, actor_key TEXT NOT NULL, entity_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, accepted_at TEXT NOT NULL, updated_at TEXT NOT NULL);
