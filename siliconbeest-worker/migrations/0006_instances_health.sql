-- Migration: 0006_instances_health
-- Add open_registrations column to instances table for health tracking.
-- Note: last_failed_at, title, description already exist from 0001_initial_schema.

ALTER TABLE instances ADD COLUMN open_registrations INTEGER DEFAULT 0;
