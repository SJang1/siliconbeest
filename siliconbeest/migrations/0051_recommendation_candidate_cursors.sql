-- Bound recommendation permission checks to recent active surfaces. These
-- covering partial indexes let the materialized source windows stop after a
-- few hundred rows instead of scanning every status before the final LIMIT.
CREATE INDEX IF NOT EXISTS idx_statuses_recommendation_original_cursor
  ON statuses(created_at DESC, id DESC, visibility)
  WHERE reblog_of_id IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_statuses_recommendation_boost_cursor
  ON statuses(created_at DESC, id DESC, reblog_of_id, visibility)
  WHERE reblog_of_id IS NOT NULL AND deleted_at IS NULL;
