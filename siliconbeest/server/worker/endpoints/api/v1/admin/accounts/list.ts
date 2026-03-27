import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/accounts — list all accounts with filters.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const maxId = c.req.query('max_id');
	const minId = c.req.query('min_id');
	const origin = c.req.query('origin'); // local | remote
	const status = c.req.query('status'); // active | pending | disabled | silenced | suspended
	const username = c.req.query('username');
	const displayName = c.req.query('display_name');
	const email = c.req.query('email');
	const ip = c.req.query('ip');
	const staff = c.req.query('staff');

	// Shorthand filter params (Mastodon compat)
	const local = c.req.query('local');
	const remote = c.req.query('remote');
	const active = c.req.query('active');
	const pending = c.req.query('pending');
	const disabled = c.req.query('disabled');
	const silenced = c.req.query('silenced');
	const suspended = c.req.query('suspended');

	const conditions: string[] = [];
	const bindings: unknown[] = [];
	let bindIdx = 1;

	// Origin filters
	const effectiveOrigin = origin || (local ? 'local' : remote ? 'remote' : null);
	if (effectiveOrigin === 'local') {
		conditions.push('a.domain IS NULL');
	} else if (effectiveOrigin === 'remote') {
		conditions.push('a.domain IS NOT NULL');
	}

	// Status filters
	const effectiveStatus =
		status ||
		(active ? 'active' : pending ? 'pending' : disabled ? 'disabled' : silenced ? 'silenced' : suspended ? 'suspended' : null);

	if (effectiveStatus === 'active') {
		conditions.push('a.suspended_at IS NULL AND a.silenced_at IS NULL');
		conditions.push('(u.disabled IS NULL OR u.disabled = 0)');
		conditions.push('(u.approved IS NULL OR u.approved = 1)');
	} else if (effectiveStatus === 'pending') {
		conditions.push('u.approved = 0');
	} else if (effectiveStatus === 'disabled') {
		conditions.push('u.disabled = 1');
	} else if (effectiveStatus === 'silenced') {
		conditions.push('a.silenced_at IS NOT NULL');
	} else if (effectiveStatus === 'suspended') {
		conditions.push('a.suspended_at IS NOT NULL');
	}

	if (username) {
		conditions.push(`a.username LIKE ?${bindIdx}`);
		bindings.push(`%${username}%`);
		bindIdx++;
	}

	if (displayName) {
		conditions.push(`a.display_name LIKE ?${bindIdx}`);
		bindings.push(`%${displayName}%`);
		bindIdx++;
	}

	if (email) {
		conditions.push(`u.email LIKE ?${bindIdx}`);
		bindings.push(`%${email}%`);
		bindIdx++;
	}

	if (ip) {
		conditions.push(`u.current_sign_in_ip = ?${bindIdx}`);
		bindings.push(ip);
		bindIdx++;
	}

	if (staff === 'true') {
		conditions.push("u.role IN ('admin', 'moderator')");
	}

	// Pagination
	if (maxId) {
		conditions.push(`a.id < ?${bindIdx}`);
		bindings.push(maxId);
		bindIdx++;
	}

	if (minId) {
		conditions.push(`a.id > ?${bindIdx}`);
		bindings.push(minId);
		bindIdx++;
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const orderDirection = minId ? 'ASC' : 'DESC';

	const sql = `
		SELECT
			a.*,
			u.id AS user_id,
			u.email AS user_email,
			u.role AS user_role,
			u.disabled AS user_disabled,
			u.approved AS user_approved,
			u.current_sign_in_ip,
			u.current_sign_in_at,
			u.last_sign_in_ip,
			u.last_sign_in_at,
			u.created_at AS user_created_at,
			u.confirmed_at,
			u.locale
		FROM accounts a
		LEFT JOIN users u ON u.account_id = a.id
		${where}
		ORDER BY a.id ${orderDirection}
		LIMIT ?${bindIdx}
	`;
	bindings.push(limit);

	const { results } = await c.env.DB.prepare(sql).bind(...bindings).all();
	const domain = c.env.INSTANCE_DOMAIN;

	const accounts = (results || []).map((row) => formatAdminAccount(row, domain));

	// If paginating forward (minId), reverse to get descending order
	if (minId) accounts.reverse();

	return c.json(accounts);
});

function formatAdminAccount(row: Record<string, unknown>, domain: string) {
	const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
	return {
		id: row.id as string,
		username: row.username as string,
		domain: (row.domain as string) || null,
		created_at: row.created_at as string,
		email: (row.user_email as string) || null,
		ip: (row.current_sign_in_ip as string) || null,
		role: (row.user_role as string) || null,
		confirmed: !!(row.confirmed_at),
		approved: row.user_approved === null ? true : !!(row.user_approved),
		disabled: !!(row.user_disabled),
		silenced: !!(row.silenced_at),
		suspended: !!(row.suspended_at),
		locale: (row.locale as string) || null,
		invite_request: null,
		ips: row.current_sign_in_ip
			? [{ ip: row.current_sign_in_ip as string, used_at: (row.current_sign_in_at as string) || '' }]
			: [],
		created_by_application_id: (row.created_by_application_id as string) || null,
		account: {
			id: row.id as string,
			username: row.username as string,
			acct,
			display_name: (row.display_name as string) || '',
			locked: !!(row.locked),
			bot: !!(row.bot),
			discoverable: !!(row.discoverable),
			group: false,
			created_at: row.created_at as string,
			note: (row.note as string) || '',
			url: (row.url as string) || `https://${domain}/@${row.username}`,
			uri: row.uri as string,
			avatar: (row.avatar_url as string) || null,
			avatar_static: (row.avatar_static_url as string) || null,
			header: (row.header_url as string) || null,
			header_static: (row.header_static_url as string) || null,
			followers_count: (row.followers_count as number) || 0,
			following_count: (row.following_count as number) || 0,
			statuses_count: (row.statuses_count as number) || 0,
			last_status_at: (row.last_status_at as string) || null,
			emojis: [],
			fields: [],
		},
	};
}

export default app;
