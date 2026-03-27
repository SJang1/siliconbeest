import { generateUlid } from '../utils/ulid';

export interface MediaAttachment {
	id: string;
	status_id: string | null;
	account_id: string;
	file_key: string;
	file_content_type: string;
	file_size: number;
	thumbnail_key: string | null;
	remote_url: string | null;
	description: string;
	blurhash: string | null;
	width: number | null;
	height: number | null;
	type: string;
	created_at: string;
	updated_at: string;
}

export interface CreateMediaInput {
	account_id: string;
	file_key: string;
	file_content_type: string;
	file_size?: number;
	thumbnail_key?: string | null;
	remote_url?: string | null;
	description?: string;
	blurhash?: string | null;
	width?: number | null;
	height?: number | null;
	type?: string;
}

export class MediaRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<MediaAttachment | null> {
		const result = await this.db
			.prepare('SELECT * FROM media_attachments WHERE id = ?')
			.bind(id)
			.first<MediaAttachment>();
		return result ?? null;
	}

	async findByStatusId(statusId: string): Promise<MediaAttachment[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM media_attachments WHERE status_id = ? ORDER BY created_at ASC')
			.bind(statusId)
			.all<MediaAttachment>();
		return results;
	}

	async findUnattached(accountId: string): Promise<MediaAttachment[]> {
		const { results } = await this.db
			.prepare(
				'SELECT * FROM media_attachments WHERE account_id = ? AND status_id IS NULL ORDER BY created_at DESC'
			)
			.bind(accountId)
			.all<MediaAttachment>();
		return results;
	}

	async create(input: CreateMediaInput): Promise<MediaAttachment> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const media: MediaAttachment = {
			id,
			status_id: null,
			account_id: input.account_id,
			file_key: input.file_key,
			file_content_type: input.file_content_type,
			file_size: input.file_size ?? 0,
			thumbnail_key: input.thumbnail_key ?? null,
			remote_url: input.remote_url ?? null,
			description: input.description ?? '',
			blurhash: input.blurhash ?? null,
			width: input.width ?? null,
			height: input.height ?? null,
			type: input.type ?? 'image',
			created_at: now,
			updated_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO media_attachments (
					id, status_id, account_id, file_key, file_content_type, file_size,
					thumbnail_key, remote_url, description, blurhash,
					width, height, type, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				media.id, media.status_id, media.account_id,
				media.file_key, media.file_content_type, media.file_size,
				media.thumbnail_key, media.remote_url, media.description,
				media.blurhash, media.width, media.height, media.type,
				media.created_at, media.updated_at
			)
			.run();

		return media;
	}

	async update(
		id: string,
		input: Partial<Pick<MediaAttachment, 'description' | 'blurhash' | 'width' | 'height' | 'thumbnail_key'>>
	): Promise<MediaAttachment | null> {
		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		for (const [key, value] of Object.entries(input)) {
			fields.push(`${key} = ?`);
			values.push(value);
		}

		if (fields.length === 0) return this.findById(id);

		fields.push('updated_at = ?');
		values.push(now);
		values.push(id);

		await this.db
			.prepare(`UPDATE media_attachments SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		return this.findById(id);
	}

	async attachToStatus(ids: string[], statusId: string): Promise<void> {
		if (ids.length === 0) return;
		const now = new Date().toISOString();

		const stmts = ids.map((mediaId) =>
			this.db
				.prepare('UPDATE media_attachments SET status_id = ?, updated_at = ? WHERE id = ?')
				.bind(statusId, now, mediaId)
		);

		await this.db.batch(stmts);
	}
}
