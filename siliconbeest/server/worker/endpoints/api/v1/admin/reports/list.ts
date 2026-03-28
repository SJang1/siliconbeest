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
		SELECT r.*,
			a1.username AS reporter_username, a1.domain AS reporter_domain,
			a1.display_name AS reporter_display_name, a1.avatar_url AS reporter_avatar_url,
			a1.url AS reporter_url, a1.uri AS reporter_uri,
			a2.username AS target_username, a2.domain AS target_domain,
			a2.display_name AS target_display_name, a2.avatar_url AS target_avatar_url,
			a2.url AS target_url, a2.uri AS target_uri
		FROM reports r
		LEFT JOIN accounts a1 ON a1.id = r.account_id
		LEFT JOIN accounts a2 ON a2.id = r.target_account_id
		${where}
		ORDER BY r.id ${orderDirection}
		LIMIT ?${bindIdx}
	`;
	bindings.push(limit);

	const { results } = await c.env.DB.prepare(sql).bind(...bindings).all();

	const domain = c.env.INSTANCE_DOMAIN;
	const reports = (results || []).map((row) => formatReport(row, domain));

	if (minId) reports.reverse();

	return c.json(reports);
});

function formatAccount(row: Record<string, unknown>, prefix: string, instanceDomain: string) {
	const username = row[`${prefix}_username`] as string;
	const domain = row[`${prefix}_domain`] as string | null;
	const acct = domain ? `${username}@${domain}` : username;
	const url = (row[`${prefix}_url`] as string) || (domain ? row[`${prefix}_uri`] as string : `https://${instanceDomain}/@${username}`);
	return {
		id: row[`${prefix === 'reporter' ? 'account_id' : 'target_account_id'}`] as string,
		username,
		acct,
		display_name: (row[`${prefix}_display_name`] as string) || '',
		url,
		avatar: (row[`${prefix}_avatar_url`] as string) || '',
		avatar_static: (row[`${prefix}_avatar_url`] as string) || '',
	};
}

function formatReport(row: Record<string, unknown>, instanceDomain: string) {
	return {
		id: row.id as string,
		action_taken: !!(row.action_taken_at),
		action_taken_at: (row.action_taken_at as string) || null,
		category: (row.category as string) || 'other',
		comment: (row.comment as string) || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || row.created_at as string,
		account: formatAccount(row, 'reporter', instanceDomain),
		target_account: formatAccount(row, 'target', instanceDomain),
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id as string } : null,
		action_taken_by_account: row.action_taken_by_account_id ? { id: row.action_taken_by_account_id as string } : null,
		statuses: [],
		rules: [],
	};
}

export default app;
