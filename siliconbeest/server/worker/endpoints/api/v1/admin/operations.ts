import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { adminOnlyRequired, adminRequired, authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { requireScopeForMethod } from '../../../../middleware/scopeCheck';

type HonoEnv = { Variables: AppVariables };

type ParkedOperation = {
  operation_id: string;
  workload: 'registration' | 'd1_write';
  body_hash: string;
  target_ordinal: number;
  target_binding: string;
  error_class: string;
  error: string;
  status: 'parked' | 'retrying' | 'discarded' | 'recovered';
  parked_at: string;
  updated_at: string;
};

const app = new Hono<HonoEnv>();
app.use('*', authRequired, adminRequired, adminOnlyRequired);
app.use('*', requireScopeForMethod('admin:read', 'admin:write'));

app.get('/parked', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 40, 1), 200);
  const status = c.req.query('status') ?? 'parked';
  if (!['parked', 'retrying', 'discarded', 'recovered'].includes(status)) {
    throw new AppError(400, 'Invalid parked operation status');
  }
  const rows = await env.DB_META_C000.prepare(
    `SELECT operation_id, workload, body_hash, target_ordinal, target_binding,
            error_class, error, status, parked_at, updated_at
     FROM ops_parked_writes WHERE status = ?1
     ORDER BY parked_at DESC, operation_id DESC LIMIT ?2`,
  ).bind(status, limit).all<ParkedOperation>();
  return c.json({ items: rows.results ?? [] });
});

app.post('/parked/:operationId/retry', async (c) => {
  const row = await requireParked(c.req.param('operationId'));
  if (row.workload !== 'registration') {
    throw new AppError(409, `Retry is not supported for workload ${row.workload}`);
  }
  const journal = env.REGISTRATION_JOURNAL_DO.getByName(row.operation_id);
  const command = await journal.getCommand(row.operation_id);
  if (!command || await sha256(JSON.stringify({ type: 'registration', command })) !== row.body_hash) {
    throw new AppError(409, 'Parked operation journal integrity check failed');
  }
  await journal.retry(row.operation_id);
  await env.DB_META_C000.prepare(
    "UPDATE ops_parked_writes SET status = 'retrying', updated_at = ?1 WHERE operation_id = ?2 AND status = 'parked'",
  ).bind(new Date().toISOString(), row.operation_id).run();
  return c.json({ operation_id: row.operation_id, status: 'retrying' }, 202);
});

app.delete('/parked/:operationId', async (c) => {
  const row = await requireParked(c.req.param('operationId'));
  await env.DB_META_C000.prepare(
    "UPDATE ops_parked_writes SET status = 'discarded', updated_at = ?1 WHERE operation_id = ?2 AND status = 'parked'",
  ).bind(new Date().toISOString(), row.operation_id).run();
  return c.json({ operation_id: row.operation_id, status: 'discarded' });
});

async function requireParked(operationId: string): Promise<ParkedOperation> {
  const row = await env.DB_META_C000.prepare(
    'SELECT * FROM ops_parked_writes WHERE operation_id = ?1',
  ).bind(operationId).first<ParkedOperation>();
  if (!row) throw new AppError(404, 'Parked operation not found');
  if (row.status !== 'parked') throw new AppError(409, `Operation already ${row.status}`);
  return row;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default app;
