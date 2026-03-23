import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /oauth/revoke
app.post('/', async (c) => {
	const body = await c.req.parseBody();
	const token = body.token as string | undefined;

	if (token) {
		// Mark the token as revoked
		const now = new Date().toISOString();
		await c.env.DB.prepare(
			`UPDATE oauth_access_tokens SET revoked_at = ?1 WHERE token = ?2 AND revoked_at IS NULL`,
		)
			.bind(now, token)
			.run();

		// Invalidate the KV cache for this token
		const data = new TextEncoder().encode(token);
		const hash = await crypto.subtle.digest('SHA-256', data);
		const hex = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		await c.env.CACHE.delete(`token:${hex}`);
	}

	// Per RFC 7009, always return 200 OK regardless
	return c.json({});
});

export default app;
