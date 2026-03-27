-- Account Migration support: alias list and migration timestamp
ALTER TABLE accounts ADD COLUMN also_known_as TEXT;  -- JSON array: ["https://old.server/users/me"]
ALTER TABLE accounts ADD COLUMN moved_at TEXT;        -- ISO timestamp of migration
