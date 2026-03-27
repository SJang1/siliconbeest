import { generateUlid } from '../utils/ulid';

export interface OAuthApplication {
	id: string;
	name: string;
	website: string | null;
	redirect_uri: string;
	client_id: string;
	client_secret: string;
	scopes: string;
	created_at: string;
	updated_at: string;
}

export interface CreateOAuthAppInput {
	name: string;
	redirect_uri: string;
	client_id: string;
	client_secret: string;
	website?: string | null;
	scopes?: string;
}

export class OAuthAppRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<OAuthApplication | null> {
		const result = await this.db
			.prepare('SELECT * FROM oauth_applications WHERE id = ?')
			.bind(id)
			.first<OAuthApplication>();
		return result ?? null;
	}

	async findByClientId(clientId: string): Promise<OAuthApplication | null> {
		const result = await this.db
			.prepare('SELECT * FROM oauth_applications WHERE client_id = ?')
			.bind(clientId)
			.first<OAuthApplication>();
		return result ?? null;
	}

	async create(input: CreateOAuthAppInput): Promise<OAuthApplication> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const app: OAuthApplication = {
			id,
			name: input.name,
			website: input.website ?? null,
			redirect_uri: input.redirect_uri,
			client_id: input.client_id,
			client_secret: input.client_secret,
			scopes: input.scopes ?? 'read',
			created_at: now,
			updated_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO oauth_applications (
					id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				app.id, app.name, app.website, app.redirect_uri,
				app.client_id, app.client_secret, app.scopes,
				app.created_at, app.updated_at
			)
			.run();

		return app;
	}
}
