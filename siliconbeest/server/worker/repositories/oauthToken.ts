import { generateUlid } from '../utils/ulid';

export interface OAuthAccessToken {
	id: string;
	token: string;
	refresh_token: string | null;
	application_id: string;
	user_id: string | null;
	scopes: string;
	expires_at: string | null;
	revoked_at: string | null;
	created_at: string;
}

export interface CreateOAuthTokenInput {
	token: string;
	application_id: string;
	scopes: string;
	refresh_token?: string | null;
	user_id?: string | null;
	expires_at?: string | null;
}

export class OAuthTokenRepository {
	constructor(private db: D1Database) {}

	async findByToken(token: string): Promise<OAuthAccessToken | null> {
		const result = await this.db
			.prepare('SELECT * FROM oauth_access_tokens WHERE token = ? AND revoked_at IS NULL')
			.bind(token)
			.first<OAuthAccessToken>();
		return result ?? null;
	}

	async findByUserId(userId: string): Promise<OAuthAccessToken[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM oauth_access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
			.bind(userId)
			.all<OAuthAccessToken>();
		return results;
	}

	async create(input: CreateOAuthTokenInput): Promise<OAuthAccessToken> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const token: OAuthAccessToken = {
			id,
			token: input.token,
			refresh_token: input.refresh_token ?? null,
			application_id: input.application_id,
			user_id: input.user_id ?? null,
			scopes: input.scopes,
			expires_at: input.expires_at ?? null,
			revoked_at: null,
			created_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO oauth_access_tokens (
					id, token, refresh_token, application_id, user_id,
					scopes, expires_at, revoked_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				token.id, token.token, token.refresh_token,
				token.application_id, token.user_id,
				token.scopes, token.expires_at, token.revoked_at,
				token.created_at
			)
			.run();

		return token;
	}

	async revoke(tokenId: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE id = ?')
			.bind(now, tokenId)
			.run();
	}
}
