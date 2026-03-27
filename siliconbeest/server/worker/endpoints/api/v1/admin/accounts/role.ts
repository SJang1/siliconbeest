import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const VALID_ROLES = ['user', 'moderator', 'admin'];

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/role — change a user's role.
 * Body: { role: 'user' | 'moderator' | 'admin' }
 */
app.post('/:id/role', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
	const role = body.role;

	if (!role || !VALID_ROLES.includes(role)) {
		throw new AppError(422, `Validation failed: role must be one of ${VALID_ROLES.join(', ')}`);
	}

	// Verify account exists
	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	// Verify user exists
	const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE account_id = ?1').bind(id).first();
	if (!user) throw new AppError(404, 'Record not found');

	// Update role
	await c.env.DB.prepare('UPDATE users SET role = ?1, updated_at = ?2 WHERE account_id = ?3')
		.bind(role, new Date().toISOString(), id)
		.run();

	// Invalidate token cache for this user — find all active tokens and delete from KV
	const { results: tokens } = await c.env.DB.prepare(
		'SELECT token FROM oauth_access_tokens WHERE user_id = ?1 AND revoked_at IS NULL',
	).bind(user.id as string).all();

	if (tokens && tokens.length > 0) {
		const encoder = new TextEncoder();
		for (const t of tokens) {
			const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(t.token as string));
			const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
			await c.env.CACHE.delete(`token:${hashHex}`);
		}
	}

	return c.json({ id, role }, 200);
});

export default app;
