import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/approve — approve a pending registration.
 */
app.post('/:id/approve', async (c) => {
	const id = c.req.param('id');
	const domain = c.env.INSTANCE_DOMAIN;

	// Verify the account exists
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	// Check that the user is actually pending
	const user = await c.env.DB.prepare('SELECT * FROM users WHERE account_id = ?1').bind(id).first();
	if (!user) throw new AppError(404, 'Record not found');
	if (user.approved) throw new AppError(403, 'This account is not pending approval');

	// Approve
	await c.env.DB.prepare('UPDATE users SET approved = 1 WHERE account_id = ?1').bind(id).run();

	const acct = account.domain ? `${account.username}@${account.domain}` : (account.username as string);

	return c.json({
		id: account.id as string,
		username: account.username as string,
		domain: (account.domain as string) || null,
		created_at: account.created_at as string,
		email: (user.email as string) || null,
		ip: (user.current_sign_in_ip as string) || null,
		role: (user.role as string) || null,
		confirmed: !!(user.confirmed_at),
		approved: true,
		disabled: !!(user.disabled),
		silenced: !!(account.silenced_at),
		suspended: !!(account.suspended_at),
		locale: (user.locale as string) || null,
		invite_request: null,
		ips: user.current_sign_in_ip
			? [{ ip: user.current_sign_in_ip as string, used_at: (user.current_sign_in_at as string) || '' }]
			: [],
		created_by_application_id: (user.created_by_application_id as string) || null,
		account: {
			id: account.id as string,
			username: account.username as string,
			acct,
			display_name: (account.display_name as string) || '',
			locked: !!(account.locked),
			bot: !!(account.bot),
			discoverable: !!(account.discoverable),
			group: false,
			created_at: account.created_at as string,
			note: (account.note as string) || '',
			url: (account.url as string) || `https://${domain}/@${account.username}`,
			uri: account.uri as string,
			avatar: (account.avatar_url as string) || '',
			avatar_static: (account.avatar_static_url as string) || '',
			header: (account.header_url as string) || '',
			header_static: (account.header_static_url as string) || '',
			followers_count: (account.followers_count as number) || 0,
			following_count: (account.following_count as number) || 0,
			statuses_count: (account.statuses_count as number) || 0,
			last_status_at: (account.last_status_at as string) || null,
			emojis: [],
			fields: [],
		},
	});
});

export default app;
