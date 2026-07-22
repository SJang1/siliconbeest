/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';

export class InvitationLedgerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS claims (
          operation_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'committed')),
          expires_at INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_active_claim
        ON claims (state) WHERE state = 'reserved';
      `);
    });
  }

  async reserve(operationId: string, ttlMs = 300_000): Promise<boolean> {
    this.expire();
    const owned = this.ctx.storage.sql.exec<{ operation_id: string }>(
      'SELECT operation_id FROM claims WHERE operation_id = ?', operationId,
    ).toArray()[0];
    if (owned) return true;
    const active = this.ctx.storage.sql.exec<{ operation_id: string }>(
      "SELECT operation_id FROM claims WHERE state = 'reserved' LIMIT 1",
    ).toArray()[0];
    if (active) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO claims (operation_id, state, expires_at, updated_at) VALUES (?, 'reserved', ?, ?)",
      operationId,
      Date.now() + ttlMs,
      new Date().toISOString(),
    );
    await this.ctx.storage.setAlarm(Date.now() + ttlMs);
    return true;
  }

  commit(operationId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE claims SET state = 'committed', expires_at = NULL, updated_at = ? WHERE operation_id = ?",
      new Date().toISOString(), operationId,
    );
  }

  release(operationId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM claims WHERE operation_id = ? AND state = 'reserved'", operationId,
    );
  }

  alarm(): void { this.expire(); }

  private expire(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM claims WHERE state = 'reserved' AND expires_at <= ?", Date.now(),
    );
  }
}
