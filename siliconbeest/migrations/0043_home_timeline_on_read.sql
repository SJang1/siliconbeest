-- Derive home timelines from statuses, follows, and mentions at read time.
-- The global cursor index lets the API scan statuses newest-first and stop as
-- soon as it has collected one page of eligible rows.
CREATE INDEX IF NOT EXISTS idx_statuses_timeline_cursor
  ON statuses(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_statuses_account_timeline
  ON statuses(account_id, created_at DESC, id DESC);

DROP INDEX IF EXISTS idx_statuses_account_created;

CREATE INDEX IF NOT EXISTS idx_mentions_account_status
  ON mentions(account_id, status_id);

-- Reclaim existing materialized timeline storage while preserving a no-op
-- compatibility target during a rolling deployment. All legacy writers use
-- INSERT OR IGNORE, so the CHECK constraint discards their writes until every
-- worker is running the on-read implementation.
DROP TABLE home_timeline_entries;

CREATE TABLE home_timeline_entries (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  status_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  CHECK (0) ON CONFLICT IGNORE
);
