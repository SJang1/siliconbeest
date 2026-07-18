-- Keep Article metadata in Mastodon-compatible edit history snapshots.
ALTER TABLE status_edits ADD COLUMN object_type TEXT NOT NULL DEFAULT 'Note';
ALTER TABLE status_edits ADD COLUMN title TEXT NOT NULL DEFAULT '';
