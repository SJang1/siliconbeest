-- Preserve the ActivityStreams object type and Article title for statuses.
-- Existing statuses remain Notes, while polls continue to be represented as Questions
-- at serialization time through their poll_id.
ALTER TABLE statuses ADD COLUMN object_type TEXT NOT NULL DEFAULT 'Note';
ALTER TABLE statuses ADD COLUMN title TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_statuses_object_type_created
  ON statuses(object_type, created_at DESC);
