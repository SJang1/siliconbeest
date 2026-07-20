-- Recommendation revalidation starts from a bounded set of original status
-- IDs, then looks for an active home-eligible boost wrapper. Keep that lookup
-- small and covering without indexing deleted originals or non-boost posts.
CREATE INDEX IF NOT EXISTS idx_statuses_active_reblog_surface
  ON statuses(reblog_of_id, account_id, visibility, id)
  WHERE reblog_of_id IS NOT NULL AND deleted_at IS NULL;
