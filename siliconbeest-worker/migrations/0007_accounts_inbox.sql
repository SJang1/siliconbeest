-- AP spec requires each actor to have an inbox URL
-- Also add shared_inbox_url and outbox_url for federation optimization
ALTER TABLE accounts ADD COLUMN inbox_url TEXT;
ALTER TABLE accounts ADD COLUMN shared_inbox_url TEXT;
ALTER TABLE accounts ADD COLUMN outbox_url TEXT;
ALTER TABLE accounts ADD COLUMN featured_collection_url TEXT;
