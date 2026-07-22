CREATE TABLE IF NOT EXISTS shard_metadata (
  family TEXT NOT NULL CHECK (family = 'META'),
  schema_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (family, schema_version)
);
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('META', 1);

CREATE TABLE IF NOT EXISTS account_metadata (
  id TEXT PRIMARY KEY,
  cohort INTEGER NOT NULL,
  username TEXT NOT NULL,
  domain TEXT,
  uri TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
