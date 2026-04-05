import { generateUlid } from '../utils/ulid';

export type OAuthAuthorizationCode = {
	id: string;
	code: string;
	application_id: string;
	user_id: string;
	redirect_uri: string;
	scopes: string;
	code_challenge: string | null;
	code_challenge_method: string | null;
	expires_at: string;
	used_at: string | null;
	created_at: string;
};

export type CreateOAuthCodeInput = {
	code: string;
	application_id: string;
	user_id: string;
	redirect_uri: string;
	scopes: string;
	expires_at: string;
	code_challenge?: string | null;
	code_challenge_method?: string | null;
};

export const findByCode = async (
	db: D1Database,
	code: string,
): Promise<OAuthAuthorizationCode | null> => {
	const result = await db
		.prepare('SELECT * FROM oauth_authorization_codes WHERE code = ? AND used_at IS NULL')
		.bind(code)
		.first<OAuthAuthorizationCode>();
	return result ?? null;
};

export const create = async (
	db: D1Database,
	input: CreateOAuthCodeInput,
): Promise<OAuthAuthorizationCode> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const authCode: OAuthAuthorizationCode = {
		id,
		code: input.code,
		application_id: input.application_id,
		user_id: input.user_id,
		redirect_uri: input.redirect_uri,
		scopes: input.scopes,
		code_challenge: input.code_challenge ?? null,
		code_challenge_method: input.code_challenge_method ?? null,
		expires_at: input.expires_at,
		used_at: null,
		created_at: now,
	};

	await db
		.prepare(
			`INSERT INTO oauth_authorization_codes (
				id, code, application_id, user_id, redirect_uri, scopes,
				code_challenge, code_challenge_method, expires_at, used_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			authCode.id, authCode.code, authCode.application_id,
			authCode.user_id, authCode.redirect_uri, authCode.scopes,
			authCode.code_challenge, authCode.code_challenge_method,
			authCode.expires_at, authCode.used_at, authCode.created_at
		)
		.run();

	return authCode;
};

export const markUsed = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = new Date().toISOString();
	await db
		.prepare('UPDATE oauth_authorization_codes SET used_at = ? WHERE id = ?')
		.bind(now, id)
		.run();
};
