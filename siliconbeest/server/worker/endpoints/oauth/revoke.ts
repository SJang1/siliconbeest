import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /oauth/revoke
app.post('/', async (c) => {
	const body = await c.req.parseBody();
	const token = body.token as string | undefined;

	if (token) {
		// Compute SHA-256 hash for lookup
		const data = new TextEncoder().encode(token);
		const hashBuf = await crypto.subtle.digest('SHA-256', data);
		const hex = Array.from(new Uint8Array(hashBuf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		// Mark the token as revoked (try hash first, then plaintext for legacy)
		const now = new Date().toISOString();
		const result = await c.env.DB.prepare(
			`UPDATE oauth_access_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL`,
		)
			.bind(now, hex)
			.run();

		if (!result.meta.changes) {
			// Fallback for legacy plaintext tokens
			await c.env.DB.prepare(
				`UPDATE oauth_access_tokens SET revoked_at = ?1 WHERE token = ?2 AND revoked_at IS NULL`,
			)
				.bind(now, token)
				.run();
		}

		// Invalidate the KV cache for this token
		await c.env.CACHE.delete(`token:${hex}`);
	}

	// Per RFC 7009, always return 200 OK regardless
	return c.json({});
});

export default app;
