import { generateUlid } from '../utils/ulid';
import { sha256 } from '../utils/crypto';

export type OAuthAccessToken = {
	id: string;
	token: string;
	token_hash: string | null;
	refresh_token: string | null;
	application_id: string;
	user_id: string | null;
	scopes: string;
	expires_at: string | null;
	revoked_at: string | null;
	created_at: string;
};

export type CreateOAuthTokenInput = {
	token: string;
	application_id: string;
	scopes: string;
	refresh_token?: string | null;
	user_id?: string | null;
	expires_at?: string | null;
};

export const findByToken = async (
	db: D1Database,
	token: string,
): Promise<OAuthAccessToken | null> => {
	const hash = await sha256(token);
	// Try hash first, fall back to plaintext for legacy tokens
	const resultByHash = await db
		.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash = ? AND revoked_at IS NULL')
		.bind(hash)
		.first<OAuthAccessToken>();

	return resultByHash ?? await db
		.prepare('SELECT * FROM oauth_access_tokens WHERE token = ? AND revoked_at IS NULL')
		.bind(token)
		.first<OAuthAccessToken>() ?? null;
};

export const findByUserId = async (
	db: D1Database,
	userId: string,
): Promise<OAuthAccessToken[]> => {
	const { results } = await db
		.prepare('SELECT * FROM oauth_access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
		.bind(userId)
		.all<OAuthAccessToken>();
	return results;
};

export const create = async (
	db: D1Database,
	input: CreateOAuthTokenInput,
): Promise<OAuthAccessToken> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const tokenHash = await sha256(input.token);
	const token: OAuthAccessToken = {
		id,
		token: input.token,
		token_hash: tokenHash,
		refresh_token: input.refresh_token ?? null,
		application_id: input.application_id,
		user_id: input.user_id ?? null,
		scopes: input.scopes,
		expires_at: input.expires_at ?? null,
		revoked_at: null,
		created_at: now,
	};

	await db
		.prepare(
			`INSERT INTO oauth_access_tokens (
				id, token_hash, refresh_token, application_id, user_id,
				scopes, expires_at, revoked_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			token.id, token.token_hash, token.refresh_token,
			token.application_id, token.user_id,
			token.scopes, token.expires_at, token.revoked_at,
			token.created_at
		)
		.run();

	return token;
};

export const revoke = async (
	db: D1Database,
	tokenId: string,
): Promise<void> => {
	const now = new Date().toISOString();
	await db
		.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE id = ?')
		.bind(now, tokenId)
		.run();
};
