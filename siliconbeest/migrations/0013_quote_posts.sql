-- FEP-e232: Quote posts support
-- Adds quote_id column to statuses table for linking quoted statuses
ALTER TABLE statuses ADD COLUMN quote_id TEXT;
CREATE INDEX idx_statuses_quote ON statuses(quote_id);
