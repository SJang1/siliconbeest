import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { sendWelcome } from '../../../../../services/email';
import { sanitizeLocale } from '../../../../../utils/locales';
import { getAccountWithUser, approveAccount } from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/approve — approve a pending registration.
 */
app.post('/:id/approve', async (c) => {
	const id = c.req.param('id');
	const domain = env.INSTANCE_DOMAIN;

	const { account, user } = await getAccountWithUser(id);

	if (user.approved) throw new AppError(403, 'This account is not pending approval');
	if (!user.confirmed_at) throw new AppError(422, 'User has not confirmed their email address');

	// Approve
	await approveAccount(id);

	// Send welcome email in user's locale (best-effort — never block approval)
	if (user.email) {
		try {
			await sendWelcome(user.email as string, account.username as string, sanitizeLocale(user.locale as string | null));
		} catch { /* email queue failure should not block approval */ }
	}

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
		invite_request: (user.reason as string) || null,
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
			avatar: (account.avatar_url as string) || null,
			avatar_static: (account.avatar_static_url as string) || null,
			header: (account.header_url as string) || null,
			header_static: (account.header_static_url as string) || null,
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
