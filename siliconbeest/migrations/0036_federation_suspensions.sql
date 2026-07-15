-- Preserve an existing domain-block severity while admin/federation
-- temporarily promotes the domain to a full federation suspension.
CREATE TABLE federation_suspensions (
  domain             TEXT PRIMARY KEY,
  domain_block_id    TEXT NOT NULL,
  previous_severity  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

