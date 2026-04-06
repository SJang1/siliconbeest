import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../types';
import { sha256 } from '../../utils/crypto';
import { revokeToken } from '../../services/oauth';

const app = new Hono<{ Variables: AppVariables }>();

// POST /oauth/revoke
app.post('/', async (c) => {
	const body = await c.req.parseBody();
	const token = body.token as string | undefined;

	if (token) {
		// Compute SHA-256 hash for lookup
		const hex = await sha256(token);

		// Mark the token as revoked via service
		await revokeToken(hex);

		// Invalidate the KV cache for this token
		await env.CACHE.delete(`token:${hex}`);
	}

	// Per RFC 7009, always return 200 OK regardless
	return c.json({});
});

export default app;
