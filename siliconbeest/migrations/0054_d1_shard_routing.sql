-- Register the existing D1 as cohort 0 / epoch 0 / physical ordinal 0.
-- Existing entity IDs remain unchanged and are explicitly assigned format 0.

CREATE TABLE IF NOT EXISTS storage_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO storage_config (key, value)
VALUES ('id_format_cutover_ms', CAST(unixepoch('subsec') * 1000 AS INTEGER));
INSERT OR IGNORE INTO storage_config (key, value)
VALUES ('active_account_cohort', '0');

CREATE TABLE IF NOT EXISTS shard_catalog (
  family TEXT NOT NULL CHECK (family IN (
    'META', 'POSTS', 'GRAPH', 'INBOX', 'REMOTE_ACTORS', 'REMOTE_POSTS', 'SEARCH_FEED', 'OPS'
  )),
  cohort INTEGER NOT NULL CHECK (cohort >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 1048575),
  binding TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('legacy', 'precreated', 'active', 'read-only')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  PRIMARY KEY (family, cohort, epoch)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shard_catalog_physical_ordinal
ON shard_catalog (ordinal) WHERE ordinal > 0;

INSERT OR IGNORE INTO shard_catalog (family, cohort, epoch, ordinal, binding, state)
VALUES
  ('META', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('POSTS', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('GRAPH', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('INBOX', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('REMOTE_ACTORS', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('REMOTE_POSTS', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('SEARCH_FEED', 0, 0, 0, 'DB_META_C000', 'legacy'),
  ('OPS', 0, 0, 0, 'DB_META_C000', 'legacy');

CREATE TABLE IF NOT EXISTS account_storage (
  account_id TEXT PRIMARY KEY,
  cohort INTEGER NOT NULL DEFAULT 0 CHECK (cohort >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO account_storage (account_id, cohort, created_at, updated_at)
SELECT id, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM accounts;

CREATE TABLE IF NOT EXISTS entity_routes (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN (
    'META', 'POSTS', 'GRAPH', 'INBOX', 'REMOTE_ACTORS', 'REMOTE_POSTS', 'SEARCH_FEED', 'OPS'
  )),
  cohort INTEGER NOT NULL DEFAULT 0 CHECK (cohort >= 0),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal BETWEEN 0 AND 1048575),
  format_version INTEGER NOT NULL DEFAULT 0 CHECK (format_version BETWEEN 0 AND 15),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_routes_location
ON entity_routes (family, cohort, epoch, ordinal);

-- Root/public entities. Relationship tables remain discoverable through their
-- owning account/status route and do not need a second global directory entry.
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'account', id, CASE WHEN domain IS NULL THEN 'META' ELSE 'REMOTE_ACTORS' END FROM accounts;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'user', id, 'META' FROM users;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'actor_key', id, 'META' FROM actor_keys;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'status', id, CASE WHEN local = 1 THEN 'POSTS' ELSE 'REMOTE_POSTS' END FROM statuses;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'conversation', id, 'INBOX' FROM conversations;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'notification', id, 'INBOX' FROM notifications;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'media_attachment', id, 'POSTS' FROM media_attachments;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'poll', id, 'POSTS' FROM polls;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'tag', id, 'SEARCH_FEED' FROM tags;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'list', id, 'GRAPH' FROM lists;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'report', id, 'OPS' FROM reports;
INSERT OR IGNORE INTO entity_routes (entity_type, entity_id, family)
SELECT 'oauth_application', id, 'META' FROM oauth_applications;

CREATE TABLE IF NOT EXISTS storage_migration_checkpoints (
  migration TEXT PRIMARY KEY,
  cursor TEXT,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  source_rows INTEGER NOT NULL DEFAULT 0,
  routed_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  missing_rows INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO storage_migration_checkpoints (
  migration, cursor, processed_rows, source_rows, routed_rows,
  duplicate_rows, missing_rows, completed_at, updated_at
)
SELECT
  '0054_entity_routes_v0',
  NULL,
  (SELECT COUNT(*) FROM entity_routes WHERE format_version = 0 AND ordinal = 0),
  (SELECT
     (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM users)
     + (SELECT COUNT(*) FROM actor_keys) + (SELECT COUNT(*) FROM statuses)
     + (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM notifications)
     + (SELECT COUNT(*) FROM media_attachments) + (SELECT COUNT(*) FROM polls)
     + (SELECT COUNT(*) FROM tags) + (SELECT COUNT(*) FROM lists)
     + (SELECT COUNT(*) FROM reports) + (SELECT COUNT(*) FROM oauth_applications)),
  (SELECT COUNT(*) FROM entity_routes
   WHERE format_version = 0 AND ordinal = 0
     AND entity_type IN (
       'account', 'user', 'actor_key', 'status', 'conversation', 'notification',
       'media_attachment', 'poll', 'tag', 'list', 'report', 'oauth_application'
     )),
  0,
  (SELECT
     (SELECT COUNT(*) FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'account' AND r.entity_id = a.id))
     + (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'user' AND r.entity_id = u.id))
     + (SELECT COUNT(*) FROM actor_keys k WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'actor_key' AND r.entity_id = k.id))
     + (SELECT COUNT(*) FROM statuses s WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'status' AND r.entity_id = s.id))
     + (SELECT COUNT(*) FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'conversation' AND r.entity_id = c.id))
     + (SELECT COUNT(*) FROM notifications n WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'notification' AND r.entity_id = n.id))
     + (SELECT COUNT(*) FROM media_attachments m WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'media_attachment' AND r.entity_id = m.id))
     + (SELECT COUNT(*) FROM polls p WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'poll' AND r.entity_id = p.id))
     + (SELECT COUNT(*) FROM tags t WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'tag' AND r.entity_id = t.id))
     + (SELECT COUNT(*) FROM lists l WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'list' AND r.entity_id = l.id))
     + (SELECT COUNT(*) FROM reports p WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'report' AND r.entity_id = p.id))
     + (SELECT COUNT(*) FROM oauth_applications o WHERE NOT EXISTS (SELECT 1 FROM entity_routes r WHERE r.entity_type = 'oauth_application' AND r.entity_id = o.id))),
  CASE WHEN
    (SELECT COUNT(*) FROM entity_routes WHERE format_version = 0 AND ordinal = 0
      AND entity_type IN (
        'account', 'user', 'actor_key', 'status', 'conversation', 'notification',
        'media_attachment', 'poll', 'tag', 'list', 'report', 'oauth_application'
      )) =
    (SELECT
       (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM users)
       + (SELECT COUNT(*) FROM actor_keys) + (SELECT COUNT(*) FROM statuses)
       + (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM notifications)
       + (SELECT COUNT(*) FROM media_attachments) + (SELECT COUNT(*) FROM polls)
       + (SELECT COUNT(*) FROM tags) + (SELECT COUNT(*) FROM lists)
       + (SELECT COUNT(*) FROM reports) + (SELECT COUNT(*) FROM oauth_applications))
    THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP;
