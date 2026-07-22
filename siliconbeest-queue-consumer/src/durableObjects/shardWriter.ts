/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';
import type { D1WriteMessage } from '../../../packages/shared/types/write';
import { failD1Write, handleD1WriteBatch } from '../handlers/d1Write';

type StagedRow = {
  operation_id: string;
  message_json: string;
  attempts: number;
};

type ShardWriterEnv = Env & {
  D1_WRITE_BATCH_MAX_OPERATIONS?: string;
  D1_WRITE_BATCH_MAX_WAIT_MS?: string;
};

const MAX_STAGING_ATTEMPTS = 8;

export class ShardWriterDO extends DurableObject<ShardWriterEnv> {
  constructor(ctx: DurableObjectState, env: ShardWriterEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS staged_writes (
          operation_id TEXT PRIMARY KEY,
          message_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          accepted_at TEXT NOT NULL,
          next_attempt_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_staged_writes_due
        ON staged_writes (next_attempt_at, accepted_at);
      `);
    });
  }

  async stage(messages: readonly D1WriteMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const ordinal = messages[0].command.shard.ordinal;
    const binding = messages[0].command.shard.binding;
    if (messages.some((message) => (
      message.command.shard.ordinal !== ordinal || message.command.shard.binding !== binding
    ))) {
      throw new Error('ShardWriterDO received commands for multiple physical shards');
    }
    for (const message of messages) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO staged_writes (
           operation_id, message_json, attempts, accepted_at, next_attempt_at
         ) VALUES (?, ?, 0, ?, NULL)`,
        message.command.operationId,
        JSON.stringify(message),
        message.command.acceptedAt,
      );
    }
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM staged_writes WHERE COALESCE(next_attempt_at, 0) <= ?',
      Date.now(),
    ).one().count;
    if (count >= this.maxOperations()) {
      await this.flush();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + this.maxWaitMs());
  }

  async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<StagedRow>(
      `SELECT operation_id, message_json, attempts
       FROM staged_writes
       WHERE COALESCE(next_attempt_at, 0) <= ?
       ORDER BY accepted_at LIMIT ?`,
      Date.now(),
      this.maxOperations(),
    ).toArray();
    if (rows.length === 0) return;

    const messages = rows.map((row) => JSON.parse(row.message_json) as D1WriteMessage);
    const result = await handleD1WriteBatch(messages);
    for (const message of [...result.committed, ...result.terminal]) {
      this.ctx.storage.sql.exec(
        'DELETE FROM staged_writes WHERE operation_id = ?',
        message.command.operationId,
      );
    }
    for (const row of rows) {
      const error = result.failed.get(row.operation_id);
      if (!error) continue;
      const message = messages.find((candidate) => candidate.command.operationId === row.operation_id);
      if (row.attempts + 1 >= MAX_STAGING_ATTEMPTS && message) {
        await failD1Write(message, error);
        this.ctx.storage.sql.exec('DELETE FROM staged_writes WHERE operation_id = ?', row.operation_id);
        continue;
      }
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(row.attempts, 8)));
      this.ctx.storage.sql.exec(
        `UPDATE staged_writes
         SET attempts = attempts + 1, next_attempt_at = ?
         WHERE operation_id = ?`,
        Date.now() + delay,
        row.operation_id,
      );
    }

    const next = this.ctx.storage.sql.exec<{ due: number | null }>(
      'SELECT MIN(COALESCE(next_attempt_at, 0)) AS due FROM staged_writes',
    ).one().due;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
  }

  private maxOperations(): number {
    const value = Number(this.env.D1_WRITE_BATCH_MAX_OPERATIONS);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 99) : 32;
  }

  private maxWaitMs(): number {
    const value = Number(this.env.D1_WRITE_BATCH_MAX_WAIT_MS);
    return Number.isSafeInteger(value) && value >= 10 ? Math.min(value, 5_000) : 50;
  }
}
