-- Add emoji_tags column to accounts for storing AP Emoji tag data
-- JSON array of { shortcode, url } objects from the actor's tag array
ALTER TABLE accounts ADD COLUMN emoji_tags TEXT;

-- Backfill: To populate emoji_tags for existing remote accounts that use custom
-- emojis in their display_name or note, re-fetch them by queuing:
--
--   SELECT id, uri, display_name FROM accounts
--   WHERE domain IS NOT NULL
--     AND (display_name LIKE '%:%:%' OR note LIKE '%:%:%')
--     AND emoji_tags IS NULL;
--
-- Then for each result, send a fetch_remote_account queue message with
-- { actorUri: row.uri, forceRefresh: true } to re-fetch and persist emoji_tags.
