-- Speed up federation delivery identity lookups by direct and shared inbox.
-- NULL inbox values cannot match a delivery target, so keep them out of the indexes.
CREATE INDEX IF NOT EXISTS idx_accounts_inbox_url
  ON accounts (inbox_url)
  WHERE inbox_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_shared_inbox_url
  ON accounts (shared_inbox_url)
  WHERE shared_inbox_url IS NOT NULL;
