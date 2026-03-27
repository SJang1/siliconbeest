-- Add fields column to accounts table for profile metadata
-- Stored as JSON array: [{"name": "Website", "value": "https://example.com", "verified_at": null}]
ALTER TABLE accounts ADD COLUMN fields TEXT DEFAULT '[]';
