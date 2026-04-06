import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { setAccountRole, getActiveTokensForUser } from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

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

	await setAccountRole(id, role);

	// Invalidate token cache for this user — find all active tokens and delete from KV
	const user = await env.DB.prepare('SELECT id FROM users WHERE account_id = ?1').bind(id).first();
	if (user) {
		const tokens = await getActiveTokensForUser(user.id as string);
		const encoder = new TextEncoder();
		for (const token of tokens) {
			const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token));
			const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
			await env.CACHE.delete(`token:${hashHex}`);
		}
	}

	return c.json({ id, role }, 200);
});

export default app;
