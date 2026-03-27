-- Migration: 0012_ed25519_keys
-- Add Ed25519 key columns for Object Integrity Proofs (FEP-8b32)

ALTER TABLE actor_keys ADD COLUMN ed25519_public_key TEXT;
ALTER TABLE actor_keys ADD COLUMN ed25519_private_key TEXT;
