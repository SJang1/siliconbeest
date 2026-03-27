-- Add published_at column to announcements table
ALTER TABLE announcements ADD COLUMN published_at TEXT;

-- Backfill: set published_at for already-published announcements
UPDATE announcements SET published_at = created_at WHERE published = 1;
