-- Add missing columns needed by fetchRemoteAccount handler
ALTER TABLE accounts ADD COLUMN fetched_at TEXT;
ALTER TABLE accounts ADD COLUMN is_bot INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_group INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN actor_type TEXT DEFAULT 'Person';
ALTER TABLE accounts ADD COLUMN public_key_pem TEXT;
ALTER TABLE accounts ADD COLUMN public_key_id TEXT;
ALTER TABLE accounts ADD COLUMN followers_url TEXT;
ALTER TABLE accounts ADD COLUMN following_url TEXT;
