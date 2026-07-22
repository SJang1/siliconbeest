/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';
import type {
  D1WriteMessage,
  WriteCommand,
  WriteOperation,
  WriteOperationState,
  WriteClaimResult,
  WriteProgress,
  WriteReceipt,
} from '../../../../packages/shared/types/write';

type OperationRow = {
  operation_id: string;
  entity_id: string;
  state: WriteOperationState;
  command_json: string;
  attempts: number;
  accepted_at: string;
  updated_at: string;
  error: string | null;
  next_attempt_at: number | null;
};

const RETRY_DELAY_MS = 5_000;

type WriteJournalEnv = {
  QUEUE_DB_INSERT: Queue<D1WriteMessage>;
  QUEUE_DB_UPDATE: Queue<D1WriteMessage>;
};

export class WriteJournalDO extends DurableObject<WriteJournalEnv> {
  constructor(ctx: DurableObjectState, env: WriteJournalEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS write_operations (
        operation_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'applying', 'committed', 'failed')),
        command_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        next_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_write_operations_entity
      ON write_operations (entity_id, accepted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_write_operations_retry
      ON write_operations (state, next_attempt_at);
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
    `);
  }

  async accept(command: WriteCommand): Promise<WriteReceipt> {
    const existing = this.getRow(command.operationId);
    if (existing) return this.toReceipt(existing);

    this.ctx.storage.sql.exec(
      `INSERT INTO write_operations (
         operation_id, entity_id, state, command_json, attempts,
         accepted_at, updated_at, error, next_attempt_at
       ) VALUES (?, ?, 'accepted', ?, 0, ?, ?, NULL, NULL)`,
      command.operationId,
      command.entityId,
      JSON.stringify(command),
      command.acceptedAt,
      command.acceptedAt,
    );

    await this.dispatchOrSchedule(command);
    return {
      operationId: command.operationId,
      entityId: command.entityId,
      state: 'pending',
    };
  }

  getOperation(operationId: string): WriteOperation | null {
    const row = this.getRow(operationId);
    return row ? this.toOperation(row) : null;
  }

  getPendingEntity(entityId: string): Readonly<Record<string, unknown>> | null {
    const row = this.ctx.storage.sql.exec<OperationRow>(
      `SELECT operation_id, entity_id, state, command_json, attempts,
              accepted_at, updated_at, error, next_attempt_at
       FROM write_operations
       WHERE entity_id = ? AND state IN ('accepted', 'queued', 'applying')
       ORDER BY accepted_at DESC LIMIT 1`,
      entityId,
    ).toArray()[0];
    if (!row) return null;
    const command = JSON.parse(row.command_json) as WriteCommand;
    return (command.payload.commandType === 'sql_batch' ? command.payload.pendingResponse : undefined) ?? {
      id: entityId,
      operation_id: row.operation_id,
      write_state: row.state,
    };
  }

  update(progress: WriteProgress): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE write_operations
       SET state = ?, updated_at = ?, error = ?, next_attempt_at = NULL
       WHERE operation_id = ? AND state IN ('accepted', 'queued', 'applying')`,
      progress.state,
      now,
      progress.error?.slice(0, 4_000) ?? null,
      progress.operationId,
    );
  }

  claim(operationId: string, leaseMs: number): WriteClaimResult {
    if (!Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError('Write claim lease must be between 1000 and 300000 milliseconds');
    }
    const row = this.getRow(operationId);
    if (!row) return 'missing';
    if (row.state === 'committed' || row.state === 'failed') return 'terminal';
    const nowMs = Date.now();
    if (row.state === 'applying' && (row.next_attempt_at ?? 0) > nowMs) return 'busy';

    this.ctx.storage.sql.exec(
      `UPDATE write_operations
       SET state = 'applying', updated_at = ?, error = NULL, next_attempt_at = ?
       WHERE operation_id = ? AND state IN ('accepted', 'queued', 'applying')`,
      new Date(nowMs).toISOString(),
      nowMs + leaseMs,
      operationId,
    );
    return 'claimed';
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql.exec<OperationRow>(
      `SELECT operation_id, entity_id, state, command_json, attempts,
              accepted_at, updated_at, error, next_attempt_at
       FROM write_operations
       WHERE state = 'accepted' AND COALESCE(next_attempt_at, 0) <= ?
       ORDER BY accepted_at LIMIT 25`,
      now,
    ).toArray();

    for (const row of due) {
      const command = JSON.parse(row.command_json) as WriteCommand;
      await this.dispatchOrSchedule(command);
    }

    const next = this.ctx.storage.sql.exec<{ next_attempt_at: number | null }>(
      `SELECT MIN(next_attempt_at) AS next_attempt_at
       FROM write_operations WHERE state = 'accepted'`,
    ).one();
    if (next.next_attempt_at !== null) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next.next_attempt_at));
    }
  }

  private getRow(operationId: string): OperationRow | undefined {
    return this.ctx.storage.sql.exec<OperationRow>(
      `SELECT operation_id, entity_id, state, command_json, attempts,
              accepted_at, updated_at, error, next_attempt_at
       FROM write_operations WHERE operation_id = ? LIMIT 1`,
      operationId,
    ).toArray()[0];
  }

  private async dispatchOrSchedule(command: WriteCommand): Promise<void> {
    const message: D1WriteMessage = { type: 'd1_write', command };
    const queue = command.kind === 'insert' ? this.env.QUEUE_DB_INSERT : this.env.QUEUE_DB_UPDATE;
    try {
      await queue.send(message);
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET state = 'queued', attempts = attempts + 1, updated_at = ?, error = NULL, next_attempt_at = NULL
         WHERE operation_id = ? AND state = 'accepted'`,
        new Date().toISOString(),
        command.operationId,
      );
    } catch (error) {
      const nextAttemptAt = Date.now() + RETRY_DELAY_MS;
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET attempts = attempts + 1, updated_at = ?, error = ?, next_attempt_at = ?
         WHERE operation_id = ? AND state = 'accepted'`,
        new Date().toISOString(),
        error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
        nextAttemptAt,
        command.operationId,
      );
      await this.ctx.storage.setAlarm(nextAttemptAt);
    }
  }

  private toReceipt(row: OperationRow): WriteReceipt {
    return { operationId: row.operation_id, entityId: row.entity_id, state: 'pending' };
  }

  private toOperation(row: OperationRow): WriteOperation {
    return {
      operationId: row.operation_id,
      entityId: row.entity_id,
      state: row.state,
      attempts: row.attempts,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }
}
