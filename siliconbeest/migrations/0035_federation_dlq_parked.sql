-- Federation DLQ post-processing.
-- Messages that exhaust federation-queue retries are moved by Cloudflare to
-- the *-federation-dlq queue. The queue consumer retries them once more and
-- parks persistent failures here for admin inspection, replay, or discard
-- (GET/POST/DELETE /api/v1/admin/federation/dlq).

CREATE TABLE IF NOT EXISTS federation_dlq_parked (
  id            TEXT PRIMARY KEY,
  queue         TEXT NOT NULL,
  message_id    TEXT,
  body          TEXT NOT NULL,
  message_type  TEXT,
  activity_type TEXT,
  activity_id   TEXT,
  actor         TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'parked',  -- parked | replayed | discarded
  parked_at     TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_federation_dlq_parked_status ON federation_dlq_parked(status, parked_at);
CREATE INDEX IF NOT EXISTS idx_federation_dlq_parked_activity ON federation_dlq_parked(activity_id);
