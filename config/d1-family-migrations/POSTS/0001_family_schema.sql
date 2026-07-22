CREATE TABLE IF NOT EXISTS shard_metadata (
  family TEXT NOT NULL CHECK (family = 'POSTS'),
  schema_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (family, schema_version)
);
INSERT OR IGNORE INTO shard_metadata (family, schema_version) VALUES ('POSTS', 1);

CREATE TABLE IF NOT EXISTS author_summaries (
  account_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  visibility TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_records_account_created
ON post_records (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS shard_outbox (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT 'QUEUE_INTERNAL',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  dispatched_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shard_outbox_pending ON shard_outbox (dispatched_at, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS applied_operations (
  operation_id TEXT PRIMARY KEY,
  aggregate_version INTEGER,
  command_type TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
