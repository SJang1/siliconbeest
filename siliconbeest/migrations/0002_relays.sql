-- Relay subscriptions
CREATE TABLE relays (
  id                 TEXT PRIMARY KEY,
  inbox_url          TEXT NOT NULL UNIQUE,
  actor_uri          TEXT,
  state              TEXT DEFAULT 'idle',
  follow_activity_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Instance actor keypair (account_id = '__instance__')
-- Reuses actor_keys table — insert happens at setup time via admin API / lazy init
