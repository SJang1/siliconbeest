import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { sha256 } from '../../utils/crypto';
import { revokeToken } from '../../services/oauth';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /oauth/revoke
app.post('/', async (c) => {
	const body = await c.req.parseBody();
	const token = body.token as string | undefined;

	if (token) {
		// Compute SHA-256 hash for lookup
		const hex = await sha256(token);

		// Mark the token as revoked via service
		await revokeToken(c.env.DB, hex);

		// Invalidate the KV cache for this token
		await c.env.CACHE.delete(`token:${hex}`);
	}

	// Per RFC 7009, always return 200 OK regardless
	return c.json({});
});

export default app;
