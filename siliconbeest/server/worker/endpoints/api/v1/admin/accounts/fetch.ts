import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/accounts/:id — admin view of a single account.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const domain = c.env.INSTANCE_DOMAIN;

	const row = await c.env.DB.prepare(
		`SELECT
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
			u.locale,
			u.invite_id,
			u.created_by_application_id
		FROM accounts a
		LEFT JOIN users u ON u.account_id = a.id
		WHERE a.id = ?1`,
	)
		.bind(id)
		.first();

	if (!row) throw new AppError(404, 'Record not found');

	const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);

	return c.json({
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
	});
});

export default app;
