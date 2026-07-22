/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';

export interface IdentityDirectoryMapping {
  accountId: string;
  userId: string;
  cohort: number;
  metaOrdinal: number;
  metaBinding: string;
}

export interface IdentityReservationOwner {
  operationId: string;
  state: 'reserved' | 'committed';
}

type ReservationRow = {
  operation_id: string;
  state: 'reserved' | 'committed';
  expires_at: number | null;
  mapping_json: string | null;
};

export class IdentityReservationDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS reservation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          operation_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'committed')),
          expires_at INTEGER,
          mapping_json TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  async reserve(operationId: string, ttlMs = 300_000): Promise<'acquired' | 'owned' | 'conflict'> {
    const existing = this.row();
    const now = Date.now();
    if (existing?.state === 'committed') return existing.operation_id === operationId ? 'owned' : 'conflict';
    if (existing && existing.operation_id !== operationId && (existing.expires_at ?? 0) > now) return 'conflict';
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO reservation (
         singleton, operation_id, state, expires_at, mapping_json, updated_at
       ) VALUES (1, ?, 'reserved', ?, NULL, ?)`,
      operationId,
      now + ttlMs,
      new Date(now).toISOString(),
    );
    await this.ctx.storage.setAlarm(now + ttlMs);
    return existing?.operation_id === operationId ? 'owned' : 'acquired';
  }

  commit(operationId: string, mapping: IdentityDirectoryMapping): boolean {
    const existing = this.row();
    if (!existing || existing.operation_id !== operationId) return false;
    this.ctx.storage.sql.exec(
      `UPDATE reservation SET state = 'committed', expires_at = NULL,
       mapping_json = ?, updated_at = ? WHERE singleton = 1 AND operation_id = ?`,
      JSON.stringify(mapping),
      new Date().toISOString(),
      operationId,
    );
    return true;
  }

  release(operationId: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM reservation
       WHERE singleton = 1 AND operation_id = ? AND state = 'reserved'`,
      operationId,
    );
  }

  lookup(): IdentityDirectoryMapping | null {
    const existing = this.row();
    if (!existing || existing.state !== 'committed' || !existing.mapping_json) return null;
    return JSON.parse(existing.mapping_json) as IdentityDirectoryMapping;
  }

  owner(): IdentityReservationOwner | null {
    const existing = this.row();
    if (!existing) return null;
    if (existing.state === 'reserved' && (existing.expires_at ?? 0) <= Date.now()) return null;
    return { operationId: existing.operation_id, state: existing.state };
  }

  alarm(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM reservation WHERE singleton = 1 AND state = 'reserved'
       AND expires_at <= ?`,
      Date.now(),
    );
  }

  private row(): ReservationRow | undefined {
    return this.ctx.storage.sql.exec<ReservationRow>(
      'SELECT operation_id, state, expires_at, mapping_json FROM reservation WHERE singleton = 1',
    ).toArray()[0];
  }
}
