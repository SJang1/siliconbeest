import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type MediaAttachment = {
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
};

export type CreateMediaInput = {
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
};

export const findById = async (id: string): Promise<MediaAttachment | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM media_attachments WHERE id = ?')
		.bind(id)
		.first<MediaAttachment>();
	return result ?? null;
};

export const findByStatusId = async (statusId: string): Promise<MediaAttachment[]> => {
	const { results } = await env.DB
		.prepare('SELECT * FROM media_attachments WHERE status_id = ? ORDER BY created_at ASC')
		.bind(statusId)
		.all<MediaAttachment>();
	return results;
};

export const findUnattached = async (accountId: string): Promise<MediaAttachment[]> => {
	const { results } = await env.DB
		.prepare(
			'SELECT * FROM media_attachments WHERE account_id = ? AND status_id IS NULL ORDER BY created_at DESC'
		)
		.bind(accountId)
		.all<MediaAttachment>();
	return results;
};

export const create = async (input: CreateMediaInput): Promise<MediaAttachment> => {
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

	await env.DB
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
};

export const update = async (
	id: string,
	input: Partial<Pick<MediaAttachment, 'description' | 'blurhash' | 'width' | 'height' | 'thumbnail_key'>>
): Promise<MediaAttachment | null> => {
	const now = new Date().toISOString();
	const entries = Object.entries(input);

	if (entries.length === 0) return findById(id);

	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), now, id];

	await env.DB
		.prepare(`UPDATE media_attachments SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return findById(id);
};

export const attachToStatus = async (ids: string[], statusId: string): Promise<void> => {
	if (ids.length === 0) return;
	const now = new Date().toISOString();

	const stmts = ids.map((mediaId) =>
		env.DB
			.prepare('UPDATE media_attachments SET status_id = ?, updated_at = ? WHERE id = ?')
			.bind(statusId, now, mediaId)
	);

	await env.DB.batch(stmts);
};
