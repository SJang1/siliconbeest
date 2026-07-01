-- FEP-044f: preserve remote canQuote approval targets for accurate UI hints.

ALTER TABLE statuses ADD COLUMN quote_policy_automatic_approvals TEXT;
ALTER TABLE statuses ADD COLUMN quote_policy_manual_approvals TEXT;
