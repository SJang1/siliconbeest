-- Recommendation results now retain the already permission-checked candidate
-- snapshot through AI ranking and cursor memoization, so the old post-ranking
-- boost revalidation lookup and its write-maintained partial index are unused.
DROP INDEX IF EXISTS idx_statuses_active_reblog_surface;
