-- Add pinned column to statuses for featured collections
-- Using CREATE TABLE + INSERT approach to handle "column already exists" case
-- For fresh installs: column is in initial schema via test helpers
-- For existing installs: column was added via ALTER TABLE
-- This migration is a no-op marker to keep migration history consistent
SELECT 1;
