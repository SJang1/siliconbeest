import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import {
	getActiveTokenCacheIdentitiesForUser,
	setAccountRole,
} from '../../../../../services/admin';
import { adminOnlyRequired } from '../../../../../middleware/auth';
import { USER_ROLES, parseUserRole } from '../../../../../../../../packages/shared/permissions';
import { sha256 } from '../../../../../utils/crypto';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/role — change a user's role.
 * Body: { role: 'user' | 'moderator' | 'admin' }
 */
app.post('/:id/role', adminOnlyRequired, async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
	const role = parseUserRole(body.role);

	if (!role) {
		throw new AppError(422, `Validation failed: role must be one of ${USER_ROLES.join(', ')}`);
	}

	await setAccountRole(id, role);

	// Invalidate token cache for this user — find all active tokens and delete from KV
	const user = await env.DB_META_C000.prepare('SELECT id FROM users WHERE account_id = ?1').bind(id).first();
	if (user) {
		const tokenIdentities = await getActiveTokenCacheIdentitiesForUser(user.id as string);
		for (const identity of tokenIdentities) {
			const hash = identity.tokenHash
				?? (identity.legacyToken ? await sha256(identity.legacyToken) : null);
			if (hash) await env.CACHE.delete(`token:${hash}`);
		}
	}

	return c.json({ id, role }, 200);
});

export default app;
