import { env } from 'cloudflare:workers';
import type {
  D1WriteMessage,
  SqlWriteStatement,
  WriteCommand,
  WriteProgress,
} from '../../../packages/shared/types/write';

const MAX_BOUND_PARAMETERS = 100;
const DEFAULT_MAX_OPERATIONS = 32;
const APPLY_LEASE_MS = 60_000;

export class WriteLeaseBusyError extends Error {}

export interface D1WriteBatchResult {
  committed: readonly D1WriteMessage[];
  terminal: readonly D1WriteMessage[];
  failed: ReadonlyMap<string, Error>;
}

type PendingOutboxRow = {
  event_id: string;
  destination: 'QUEUE_INTERNAL' | 'QUEUE_FEDERATION';
  payload_json: string;
  attempts: number;
};

function isD1Database(value: unknown): value is D1Database {
  if (!value || typeof value !== 'object') return false;
  return typeof Reflect.get(value, 'prepare') === 'function' && typeof Reflect.get(value, 'batch') === 'function';
}

function resolveDatabase(binding: string): D1Database {
  const database = Reflect.get(env, binding);
  if (!isD1Database(database)) throw new Error(`D1 binding ${binding} is not configured`);
  return database;
}

function isQueue(value: unknown): value is Queue<Record<string, unknown>> {
  return !!value && typeof value === 'object' && typeof Reflect.get(value, 'send') === 'function';
}

function resolveQueue(binding: 'QUEUE_INTERNAL' | 'QUEUE_FEDERATION'): Queue<Record<string, unknown>> {
  const queue = Reflect.get(env, binding);
  if (!isQueue(queue)) throw new Error(`Queue binding ${binding} is not configured`);
  return queue;
}

function prepare(db: D1Database, statement: SqlWriteStatement): D1PreparedStatement {
  if (statement.params.length > MAX_BOUND_PARAMETERS) {
    throw new Error(`D1 statement exceeds ${MAX_BOUND_PARAMETERS} bound parameters`);
  }
  return db.prepare(statement.sql).bind(...statement.params);
}

function maxOperations(): number {
  const raw = Number(Reflect.get(env, 'D1_WRITE_BATCH_MAX_OPERATIONS'));
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_MAX_OPERATIONS;
  return Math.min(raw, MAX_BOUND_PARAMETERS - 1);
}

async function updateProgress(progress: WriteProgress): Promise<void> {
  await env.INTERNAL_CONNECTION_MAIN.updateWriteOperation(progress);
}

async function claim(message: D1WriteMessage): Promise<'apply' | 'terminal'> {
  const { command } = message;
  const result = await env.INTERNAL_CONNECTION_MAIN.claimWriteOperation({
    actorKey: command.actorKey,
    operationId: command.operationId,
    leaseMs: APPLY_LEASE_MS,
  });
  if (result === 'terminal') return 'terminal';
  if (result === 'busy') throw new WriteLeaseBusyError(`Write operation ${command.operationId} still has an active apply lease`);
  if (result === 'missing') throw new Error(`Write operation ${command.operationId} is missing from its journal`);
  if (result !== 'claimed') throw new Error(`Unsupported write claim result: ${String(result)}`);
  return 'apply';
}

async function assertShardCapacity(command: WriteCommand): Promise<void> {
  const row = await env.DB_META_C000.prepare(
    `SELECT state FROM shard_catalog
     WHERE family = ?1 AND cohort = ?2 AND epoch = ?3 AND ordinal = ?4
     LIMIT 1`,
  ).bind(
    command.shard.family,
    command.shard.cohort,
    command.shard.epoch,
    command.shard.ordinal,
  ).first<{ state: string }>();
  const state = row?.state ?? command.shard.state;
  if (state === 'unavailable') throw new Error(`Shard ${command.shard.ordinal} is unavailable`);
  if (state === 'sealed' && (command.capacityEffect ?? 'growth') === 'growth') {
    throw new Error(
      `Shard ${command.shard.ordinal} is sealed at its capacity reserve; growth mutation rejected`,
    );
  }
}

async function findApplied(db: D1Database, commands: readonly WriteCommand[]): Promise<Set<string>> {
  if (commands.length === 0) return new Set();
  const placeholders = commands.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT operation_id FROM applied_operations WHERE operation_id IN (${placeholders})`,
  ).bind(...commands.map((command) => command.operationId)).all<{ operation_id: string }>();
  return new Set(result.results.map((row) => row.operation_id));
}

function operationStatements(db: D1Database, command: WriteCommand): D1PreparedStatement[] {
  if (command.payload.commandType !== 'sql_batch') {
    throw new Error(`Domain command ${command.payload.commandType} requires a registered shard repository`);
  }
  const statements = command.payload.statements.map((statement) => prepare(db, statement));
  statements.push(db.prepare(
    `INSERT INTO applied_operations (operation_id, aggregate_version, command_type, applied_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(
    command.operationId,
    command.aggregateVersion ?? null,
    command.payload.commandType,
    new Date().toISOString(),
  ));
  for (const [index, message] of (command.payload.postCommitMessages ?? []).entries()) {
    statements.push(db.prepare(
      `INSERT INTO shard_outbox (
         event_id, operation_id, destination, event_type, payload_json, attempts,
         next_attempt_at, dispatched_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, NULL, ?6)`,
    ).bind(
      `${command.operationId}:${index}`,
      command.operationId,
      message.binding,
      typeof message.body.type === 'string' ? message.body.type : 'unknown',
      JSON.stringify(message.body),
      new Date().toISOString(),
    ));
  }
  return statements;
}

async function applyAtomicGroup(
  db: D1Database,
  messages: readonly D1WriteMessage[],
  committed: D1WriteMessage[],
  failed: Map<string, Error>,
): Promise<void> {
  if (messages.length === 0) return;
  try {
    const applied = await findApplied(db, messages.map((message) => message.command));
    const pending = messages.filter((message) => !applied.has(message.command.operationId));
    if (pending.length > 0) {
      // A command and all of its outbox records remain in one D1 batch. Multiple
      // operations may share that transaction; a poison operation is isolated
      // by the binary split below rather than partially committing its command.
      await db.batch(pending.flatMap((message) => operationStatements(db, message.command)));
    }
    for (const message of messages) {
      await updateProgress({
        actorKey: message.command.actorKey,
        operationId: message.command.operationId,
        state: 'committed',
      });
      committed.push(message);
    }
  } catch (cause) {
    if (messages.length > 1) {
      const middle = Math.ceil(messages.length / 2);
      await applyAtomicGroup(db, messages.slice(0, middle), committed, failed);
      await applyAtomicGroup(db, messages.slice(middle), committed, failed);
      return;
    }
    const message = messages[0];
    const error = cause instanceof Error ? cause : new Error(String(cause));
    failed.set(message.command.operationId, error);
    await updateProgress({
      actorKey: message.command.actorKey,
      operationId: message.command.operationId,
      state: 'queued',
      error: error.message,
    });
  }
}

export async function dispatchShardOutbox(db: D1Database): Promise<void> {
  const pending = await db.prepare(
    `SELECT event_id, destination, payload_json, attempts
     FROM shard_outbox
     WHERE dispatched_at IS NULL AND COALESCE(next_attempt_at, 0) <= ?1
     ORDER BY created_at LIMIT 25`,
  ).bind(Date.now()).all<PendingOutboxRow>();
  for (const row of pending.results) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      await resolveQueue(row.destination).send({
        ...payload,
        __outbox_event_id: row.event_id,
      });
      await db.prepare(
        'UPDATE shard_outbox SET dispatched_at = ?1, attempts = attempts + 1, next_attempt_at = NULL WHERE event_id = ?2 AND dispatched_at IS NULL',
      ).bind(new Date().toISOString(), row.event_id).run();
    } catch (error) {
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(row.attempts, 8)));
      await db.prepare(
        'UPDATE shard_outbox SET attempts = attempts + 1, next_attempt_at = ?1 WHERE event_id = ?2 AND dispatched_at IS NULL',
      ).bind(Date.now() + delay, row.event_id).run();
      console.error(`[d1-outbox] Failed to dispatch ${row.event_id}`, error);
    }
  }
}

export async function handleD1WriteBatch(messages: readonly D1WriteMessage[]): Promise<D1WriteBatchResult> {
  const committed: D1WriteMessage[] = [];
  const terminal: D1WriteMessage[] = [];
  const failed = new Map<string, Error>();

  for (let offset = 0; offset < messages.length; offset += maxOperations()) {
    const groups = new Map<string, D1WriteMessage[]>();
    for (const message of messages.slice(offset, offset + maxOperations())) {
      try {
        await assertShardCapacity(message.command);
        if (await claim(message) === 'terminal') {
          terminal.push(message);
          continue;
        }
        const binding = message.command.shard.binding;
        const group = groups.get(binding) ?? [];
        group.push(message);
        groups.set(binding, group);
      } catch (cause) {
        failed.set(message.command.operationId, cause instanceof Error ? cause : new Error(String(cause)));
      }
    }

    for (const [binding, group] of groups) {
      const db = resolveDatabase(binding);
      await applyAtomicGroup(db, group, committed, failed);
      await dispatchShardOutbox(db);
    }
  }
  return { committed, terminal, failed };
}

export async function handleD1Write(message: D1WriteMessage): Promise<void> {
  const result = await handleD1WriteBatch([message]);
  const error = result.failed.get(message.command.operationId);
  if (error) throw error;
}

export async function failD1Write(message: D1WriteMessage, error: unknown): Promise<void> {
  await updateProgress({
    actorKey: message.command.actorKey,
    operationId: message.command.operationId,
    state: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
}
