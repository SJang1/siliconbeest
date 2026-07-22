-- Issue 60/61/62 hardening: explicit shard lifecycle, cohort admission,
-- idempotent shard writes, transactional outbox, and stable federated time.

ALTER TABLE shard_catalog RENAME TO shard_catalog_v1;

CREATE TABLE shard_catalog (
  family TEXT NOT NULL CHECK (family IN (
    'META', 'POSTS', 'GRAPH', 'INBOX', 'REMOTE_ACTORS', 'REMOTE_POSTS', 'SEARCH_FEED', 'OPS'
  )),
  cohort INTEGER NOT NULL CHECK (cohort >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 1048575),
  binding TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'legacy', 'precreated', 'active', 'draining', 'sealed', 'unavailable'
  )),
  shared_physical_database INTEGER NOT NULL DEFAULT 0 CHECK (shared_physical_database IN (0, 1)),
  schema_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  PRIMARY KEY (family, cohort, epoch)
);

INSERT INTO shard_catalog (
  family, cohort, epoch, ordinal, binding, state, shared_physical_database,
  created_at, activated_at
)
SELECT family, cohort, epoch, ordinal, binding,
       CASE state WHEN 'read-only' THEN 'sealed' ELSE state END,
       CASE WHEN ordinal = 0 THEN 1 ELSE 0 END,
       created_at, activated_at
FROM shard_catalog_v1;

DROP TABLE shard_catalog_v1;

CREATE UNIQUE INDEX idx_shard_catalog_physical_ordinal
ON shard_catalog (ordinal) WHERE ordinal > 0;
CREATE INDEX idx_shard_catalog_activation
ON shard_catalog (family, cohort, state, epoch DESC);

CREATE TABLE accepting_cohorts (
  cohort INTEGER PRIMARY KEY CHECK (cohort >= 0),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  catalog_version INTEGER NOT NULL CHECK (catalog_version >= 1),
  accepting INTEGER NOT NULL DEFAULT 0 CHECK (accepting IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cohort zero remains the only admission target until every required family
-- for another cohort has passed deployment and smoke tests.
INSERT OR IGNORE INTO accepting_cohorts (cohort, weight, catalog_version, accepting)
VALUES (0, 1, 1, 1);

CREATE TABLE cohort_capabilities (
  cohort INTEGER NOT NULL,
  capability TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort, capability)
);
INSERT OR IGNORE INTO cohort_capabilities (cohort, capability)
VALUES (0, 'registration_v1');

CREATE TABLE identity_directory (
  identity_hash TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL CHECK (identity_type IN ('email', 'username')),
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cohort INTEGER NOT NULL CHECK (cohort >= 0),
  meta_ordinal INTEGER NOT NULL CHECK (meta_ordinal BETWEEN 0 AND 1048575),
  meta_binding TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_identity_directory_account ON identity_directory (account_id);

CREATE TABLE registration_sagas (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('applying', 'account_committed', 'completed', 'failed')),
  invitation_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE applied_operations (
  operation_id TEXT PRIMARY KEY,
  aggregate_version INTEGER,
  command_type TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shard_outbox (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('QUEUE_INTERNAL', 'QUEUE_FEDERATION')),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_shard_outbox_pending
ON shard_outbox (dispatched_at, next_attempt_at, created_at);

CREATE TABLE ops_parked_writes (
  operation_id TEXT PRIMARY KEY,
  workload TEXT NOT NULL DEFAULT 'registration' CHECK (workload IN ('registration', 'd1_write')),
  body_hash TEXT NOT NULL,
  target_ordinal INTEGER NOT NULL,
  target_binding TEXT NOT NULL,
  error_class TEXT NOT NULL,
  error TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked', 'retrying', 'discarded', 'recovered')),
  parked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE statuses ADD COLUMN published_at_raw TEXT;
ALTER TABLE statuses ADD COLUMN published_at_ms INTEGER;
ALTER TABLE statuses ADD COLUMN received_at_ms INTEGER;
ALTER TABLE statuses ADD COLUMN sort_at_ms INTEGER;
ALTER TABLE statuses ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE statuses ADD COLUMN tombstoned_at TEXT;

UPDATE statuses
SET published_at_raw = CASE WHEN local = 0 THEN created_at ELSE NULL END,
    published_at_ms = CASE WHEN local = 0 THEN CAST(unixepoch(created_at) AS INTEGER) * 1000 ELSE NULL END,
    received_at_ms = CAST(unixepoch(created_at) AS INTEGER) * 1000,
    sort_at_ms = CAST(unixepoch(created_at) AS INTEGER) * 1000
WHERE sort_at_ms IS NULL;

CREATE INDEX idx_statuses_feed_sort
ON statuses (sort_at_ms DESC, id DESC);

CREATE TABLE search_feed_entries (
  feed_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal BETWEEN 0 AND 1048575),
  sort_at_ms INTEGER NOT NULL,
  author_summary_json TEXT NOT NULL,
  entity_summary_json TEXT NOT NULL,
  visibility TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  tombstoned_at TEXT,
  graph_version INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (feed_key, entity_id)
);
CREATE INDEX idx_search_feed_entries_page
ON search_feed_entries (feed_key, sort_at_ms DESC, entity_id DESC);
