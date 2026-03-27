import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/reports — list reports with optional filters.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const maxId = c.req.query('max_id');
	const minId = c.req.query('min_id');
	const resolved = c.req.query('resolved');
	const accountId = c.req.query('account_id');
	const targetAccountId = c.req.query('target_account_id');

	const conditions: string[] = [];
	const bindings: unknown[] = [];
	let bindIdx = 1;

	if (resolved === 'true') {
		conditions.push('r.action_taken_at IS NOT NULL');
	} else if (resolved === 'false') {
		conditions.push('r.action_taken_at IS NULL');
	}

	if (accountId) {
		conditions.push(`r.account_id = ?${bindIdx}`);
		bindings.push(accountId);
		bindIdx++;
	}

	if (targetAccountId) {
		conditions.push(`r.target_account_id = ?${bindIdx}`);
		bindings.push(targetAccountId);
		bindIdx++;
	}

	if (maxId) {
		conditions.push(`r.id < ?${bindIdx}`);
		bindings.push(maxId);
		bindIdx++;
	}

	if (minId) {
		conditions.push(`r.id > ?${bindIdx}`);
		bindings.push(minId);
		bindIdx++;
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const orderDirection = minId ? 'ASC' : 'DESC';

	const sql = `
		SELECT r.*
		FROM reports r
		${where}
		ORDER BY r.id ${orderDirection}
		LIMIT ?${bindIdx}
	`;
	bindings.push(limit);

	const { results } = await c.env.DB.prepare(sql).bind(...bindings).all();

	const reports = (results || []).map((row) => formatReport(row));

	if (minId) reports.reverse();

	return c.json(reports);
});

function formatReport(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		action_taken: !!(row.action_taken_at),
		action_taken_at: (row.action_taken_at as string) || null,
		category: (row.category as string) || 'other',
		comment: (row.comment as string) || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || row.created_at as string,
		account: { id: row.account_id as string },
		target_account: { id: row.target_account_id as string },
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id as string } : null,
		action_taken_by_account: row.action_taken_by_account_id ? { id: row.action_taken_by_account_id as string } : null,
		statuses: [],
		rules: [],
	};
}

export default app;
