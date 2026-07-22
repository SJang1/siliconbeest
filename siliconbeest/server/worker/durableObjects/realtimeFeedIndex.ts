/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';
import type {
  RealtimeFeedCursor,
  RealtimeFeedEntry,
  RealtimeFeedPage,
} from '../../../../packages/shared/types/realtimeFeed';

type FeedRow = {
  feed_key: string;
  entity_id: string;
  source_ordinal: number;
  sort_at_ms: number;
  source_version: number;
  snapshot_json: string | null;
  tombstoned: number;
};

const MAX_RETAINED_ENTRIES = 512;

export class RealtimeFeedIndexDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS feed_entries (
          feed_key TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          source_ordinal INTEGER NOT NULL,
          sort_at_ms INTEGER NOT NULL,
          source_version INTEGER NOT NULL,
          snapshot_json TEXT,
          tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
          PRIMARY KEY (feed_key, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_feed_entries_order
        ON feed_entries (feed_key, sort_at_ms DESC, entity_id DESC);
      `);
      const columns = this.ctx.storage.sql.exec<{ name: string }>(
        'PRAGMA table_info(feed_entries)',
      ).toArray();
      if (!columns.some((column) => column.name === 'tombstoned')) {
        this.ctx.storage.sql.exec(
          'ALTER TABLE feed_entries ADD COLUMN tombstoned INTEGER NOT NULL DEFAULT 0',
        );
      }
    });
  }

  project(entry: RealtimeFeedEntry): void {
    if (!Number.isSafeInteger(entry.sortAtMs) || !Number.isSafeInteger(entry.sourceVersion)) {
      throw new RangeError('Invalid real-time feed version or timestamp');
    }
    if (entry.tombstoned) {
      this.ctx.storage.sql.exec(
        `INSERT INTO feed_entries (
           feed_key, entity_id, source_ordinal, sort_at_ms, source_version, snapshot_json, tombstoned
         ) VALUES (?, ?, ?, ?, ?, NULL, 1)
         ON CONFLICT(feed_key, entity_id) DO UPDATE SET
           source_ordinal = excluded.source_ordinal,
           sort_at_ms = excluded.sort_at_ms,
           source_version = excluded.source_version,
           snapshot_json = NULL,
           tombstoned = 1
         WHERE excluded.source_version >= feed_entries.source_version`,
        entry.feedKey,
        entry.entityId,
        entry.sourceOrdinal,
        entry.sortAtMs,
        entry.sourceVersion,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO feed_entries (
         feed_key, entity_id, source_ordinal, sort_at_ms, source_version, snapshot_json, tombstoned
       ) VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(feed_key, entity_id) DO UPDATE SET
         source_ordinal = excluded.source_ordinal,
         sort_at_ms = excluded.sort_at_ms,
         source_version = excluded.source_version,
         snapshot_json = excluded.snapshot_json,
         tombstoned = 0
       WHERE excluded.source_version > feed_entries.source_version
          OR (excluded.source_version = feed_entries.source_version AND feed_entries.tombstoned = 0)`,
      entry.feedKey,
      entry.entityId,
      entry.sourceOrdinal,
      entry.sortAtMs,
      entry.sourceVersion,
      entry.snapshotJson ?? null,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM feed_entries
       WHERE feed_key = ? AND entity_id IN (
         SELECT entity_id FROM feed_entries WHERE feed_key = ?
         ORDER BY sort_at_ms DESC, entity_id DESC LIMIT -1 OFFSET ?
       )`,
      entry.feedKey,
      entry.feedKey,
      MAX_RETAINED_ENTRIES,
    );
  }

  page(feedKey: string, before: RealtimeFeedCursor | null, limit: number): RealtimeFeedPage {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = before
      ? this.ctx.storage.sql.exec<FeedRow>(
          `SELECT * FROM feed_entries
           WHERE feed_key = ? AND tombstoned = 0
             AND (sort_at_ms < ? OR (sort_at_ms = ? AND entity_id < ?))
           ORDER BY sort_at_ms DESC, entity_id DESC LIMIT ?`,
          feedKey, before.sortAtMs, before.sortAtMs, before.entityId, safeLimit,
        ).toArray()
      : this.ctx.storage.sql.exec<FeedRow>(
          `SELECT * FROM feed_entries WHERE feed_key = ? AND tombstoned = 0
           ORDER BY sort_at_ms DESC, entity_id DESC LIMIT ?`,
          feedKey, safeLimit,
        ).toArray();
    return {
      entries: rows.map((row) => ({
        feedKey: row.feed_key,
        entityId: row.entity_id,
        sourceOrdinal: row.source_ordinal,
        sortAtMs: row.sort_at_ms,
        sourceVersion: row.source_version,
        ...(row.snapshot_json ? { snapshotJson: row.snapshot_json } : {}),
      })),
    };
  }
}
