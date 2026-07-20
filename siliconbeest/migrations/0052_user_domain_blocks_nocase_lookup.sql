-- Timeline permission predicates compare domains case-insensitively. The
-- original UNIQUE(account_id, domain) index can only narrow that expression
-- to account_id, causing every blocked domain to be rescanned per candidate.
CREATE INDEX IF NOT EXISTS idx_user_domain_blocks_account_domain_lower
  ON user_domain_blocks(account_id, lower(domain));
