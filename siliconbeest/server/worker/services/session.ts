/**
 * Session Service
 *
 * Manages active OAuth access token sessions: listing, revoking,
 * and tracking IP/user-agent metadata.
 * Uses `env` from cloudflare:workers.
 */

import { env } from 'cloudflare:workers';

export interface SessionInfo {
	id: string;
	application_name: string;
	ip: string | null;
	user_agent: string | null;
	scopes: string;
	created_at: string;
	last_used_at: string | null;
	current: boolean;
}

/**
 * List all active (non-revoked, non-expired) sessions for a user.
 */
export async function listSessions(
	userId: string,
	currentTokenId: string | null,
): Promise<SessionInfo[]> {
	const { results } = await env.DB
		.prepare(
			`SELECT t.id, t.ip, t.user_agent, t.scopes, t.created_at, t.last_used_at,
			        a.name AS application_name
			 FROM oauth_access_tokens t
			 JOIN oauth_applications a ON a.id = t.application_id
			 WHERE t.user_id = ?
			   AND t.revoked_at IS NULL
			   AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
			 ORDER BY t.created_at DESC`,
		)
		.bind(userId)
		.all();

	return (results ?? []).map((row) => ({
		id: row.id as string,
		application_name: row.application_name as string,
		ip: (row.ip as string) || null,
		user_agent: (row.user_agent as string) || null,
		scopes: row.scopes as string,
		created_at: row.created_at as string,
		last_used_at: (row.last_used_at as string) || null,
		current: row.id === currentTokenId,
	}));
}

/**
 * Revoke a specific session (token) by ID.
 */
export async function revokeSession(
	userId: string,
	tokenId: string,
): Promise<boolean> {
	const now = new Date().toISOString();

	const row = await env.DB
		.prepare('SELECT token_hash FROM oauth_access_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
		.bind(tokenId, userId)
		.first<{ token_hash: string | null }>();

	if (!row) return false;

	await env.DB
		.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE id = ?')
		.bind(now, tokenId)
		.run();

	if (row.token_hash) {
		await env.CACHE.delete(`token:${row.token_hash}`);
	}

	return true;
}

/**
 * Revoke all sessions except the current one.
 */
export async function revokeAllOtherSessions(
	userId: string,
	currentTokenId: string,
): Promise<number> {
	const now = new Date().toISOString();

	const { results } = await env.DB
		.prepare(
			`SELECT id, token_hash FROM oauth_access_tokens
			 WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
		)
		.bind(userId, currentTokenId)
		.all();

	if (!results || results.length === 0) return 0;

	await env.DB
		.prepare(
			`UPDATE oauth_access_tokens SET revoked_at = ?
			 WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
		)
		.bind(now, userId, currentTokenId)
		.run();

	await Promise.all(
		results
			.filter((r) => r.token_hash)
			.map((r) => env.CACHE.delete(`token:${r.token_hash as string}`)),
	);

	return results.length;
}

/**
 * Update IP and user-agent on an access token.
 */
export async function setTokenMetadata(
	tokenId: string,
	ip: string,
	userAgent: string,
): Promise<void> {
	await env.DB
		.prepare('UPDATE oauth_access_tokens SET ip = ?, user_agent = ? WHERE id = ?')
		.bind(ip, userAgent, tokenId)
		.run();
}

/**
 * Update last_used_at timestamp on a token.
 */
export async function touchToken(
	tokenId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB
		.prepare('UPDATE oauth_access_tokens SET last_used_at = ? WHERE id = ?')
		.bind(now, tokenId)
		.run();
}
