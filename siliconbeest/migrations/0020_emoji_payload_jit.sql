/**
 * Migration 0020: Pure Lazy-Load Emoji Model
 *
 * Implements a zero-storage emoji model:
 *   - Emojis NOT stored in custom_emojis table (remote)
 *   - Emojis extracted on-demand during rendering
 *   - Emoji tag array stored with status for lazy-load
 *   - Only local emojis stored in custom_emojis table
 *   - Remote emojis never hit database except via status.emoji_tags
 *
 * JIT Proxying Paradigm:
 *   - Emojis are ephemeral, never cached or stored independently
 *   - Lazy-loaded from status payload on first render
 *   - Image URLs proxied through /proxy endpoint
 *   - Zero database writes for remote emoji ingestion
 *   - Zero storage bloat from remote emoji collection
 *
 * Benefits:
 *   - Eliminates database churn during high federation traffic
 *   - No storage bloat from remote emoji hoarding
 *   - Minimal ingestion latency (no emoji processing)
 *   - Privacy-preserving (no IP exposure to remote servers)
 */

-- Add emoji_tags column to store emoji tag array from ActivityPub payload
-- This is only used for extracting emojis during rendering (lazy-load)
ALTER TABLE statuses
ADD COLUMN emoji_tags TEXT; -- JSON array of emoji tag objects from AP status

-- Note: custom_emojis table is unchanged.
-- Only local emojis (domain IS NULL) should be stored there.
-- Remote emojis are never stored and never cached.

