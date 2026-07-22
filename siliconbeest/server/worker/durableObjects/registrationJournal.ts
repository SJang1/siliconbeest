/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';
import type {
  RegistrationCommand,
  RegistrationOperation,
  RegistrationProgress,
  RegistrationQueueMessage,
} from '../../../../packages/shared/types/registration';

type RegistrationJournalEnv = { QUEUE_REGISTRATION: Queue<RegistrationQueueMessage> };
type Row = {
  operation_id: string;
  account_id: string;
  user_id: string;
  state: RegistrationOperation['state'];
  command_json: string;
  attempts: number;
  accepted_at: string;
  updated_at: string;
  error: string | null;
  next_attempt_at: number | null;
};

export class RegistrationJournalDO extends DurableObject<RegistrationJournalEnv> {
  constructor(ctx: DurableObjectState, env: RegistrationJournalEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registration_operations (
          operation_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'applying', 'committed', 'failed')),
          command_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          accepted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          error TEXT,
          next_attempt_at INTEGER
        );
      `);
    });
  }

  async accept(command: RegistrationCommand): Promise<RegistrationOperation> {
    const existing = this.row(command.operationId);
    if (existing) return this.operation(existing);
    this.ctx.storage.sql.exec(
      `INSERT INTO registration_operations (
         operation_id, account_id, user_id, state, command_json, attempts,
         accepted_at, updated_at, error, next_attempt_at
       ) VALUES (?, ?, ?, 'accepted', ?, 0, ?, ?, NULL, NULL)`,
      command.operationId,
      command.accountId,
      command.userId,
      JSON.stringify(command),
      command.acceptedAt,
      command.acceptedAt,
    );
    await this.dispatch(command);
    return this.operation(this.row(command.operationId)!);
  }

  getOperation(operationId: string): RegistrationOperation | null {
    const row = this.row(operationId);
    return row ? this.operation(row) : null;
  }

  getCommand(operationId: string): RegistrationCommand | null {
    const row = this.row(operationId);
    return row ? JSON.parse(row.command_json) as RegistrationCommand : null;
  }

  async retry(operationId: string): Promise<RegistrationOperation> {
    const row = this.row(operationId);
    if (!row) throw new Error('Registration operation not found');
    if (row.state === 'committed') throw new Error('Committed registration cannot be retried');
    this.ctx.storage.sql.exec(
      `UPDATE registration_operations
       SET state = 'accepted', updated_at = ?, error = NULL, next_attempt_at = NULL
       WHERE operation_id = ?`,
      new Date().toISOString(),
      operationId,
    );
    await this.dispatch(JSON.parse(row.command_json) as RegistrationCommand);
    return this.operation(this.row(operationId)!);
  }

  update(progress: RegistrationProgress): void {
    this.ctx.storage.sql.exec(
      `UPDATE registration_operations SET state = ?, updated_at = ?, error = ?, next_attempt_at = NULL
       WHERE operation_id = ? AND state NOT IN ('committed', 'failed')`,
      progress.state,
      new Date().toISOString(),
      progress.error?.slice(0, 4_000) ?? null,
      progress.operationId,
    );
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<Row>(
      `SELECT * FROM registration_operations
       WHERE state = 'accepted' AND COALESCE(next_attempt_at, 0) <= ?
       ORDER BY accepted_at LIMIT 25`,
      Date.now(),
    ).toArray();
    for (const row of rows) await this.dispatch(JSON.parse(row.command_json) as RegistrationCommand);
  }

  private async dispatch(command: RegistrationCommand): Promise<void> {
    try {
      await this.env.QUEUE_REGISTRATION.send({ type: 'registration', command });
      this.ctx.storage.sql.exec(
        `UPDATE registration_operations SET state = 'queued', attempts = attempts + 1,
         updated_at = ?, error = NULL, next_attempt_at = NULL
         WHERE operation_id = ? AND state = 'accepted'`,
        new Date().toISOString(), command.operationId,
      );
    } catch (error) {
      const retryAt = Date.now() + 5_000;
      this.ctx.storage.sql.exec(
        `UPDATE registration_operations SET attempts = attempts + 1, updated_at = ?,
         error = ?, next_attempt_at = ? WHERE operation_id = ? AND state = 'accepted'`,
        new Date().toISOString(),
        error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
        retryAt,
        command.operationId,
      );
      await this.ctx.storage.setAlarm(retryAt);
    }
  }

  private row(operationId: string): Row | undefined {
    return this.ctx.storage.sql.exec<Row>(
      'SELECT * FROM registration_operations WHERE operation_id = ? LIMIT 1', operationId,
    ).toArray()[0];
  }

  private operation(row: Row): RegistrationOperation {
    return {
      operationId: row.operation_id,
      accountId: row.account_id,
      userId: row.user_id,
      state: row.state,
      attempts: row.attempts,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }
}
