CREATE TABLE IF NOT EXISTS shard_metadata (family TEXT NOT NULL CHECK (family = 'GRAPH'), schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (family, schema_version));
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('GRAPH', 1);
CREATE TABLE IF NOT EXISTS account_edges (owner_account_id TEXT NOT NULL, target_account_id TEXT NOT NULL, edge_type TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_account_id, target_account_id, edge_type));
