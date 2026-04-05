-- Add default_privacy column to users table
-- Stores the user's preferred default post visibility (public/unlisted/private/direct)
ALTER TABLE users ADD COLUMN default_privacy TEXT DEFAULT 'public';
