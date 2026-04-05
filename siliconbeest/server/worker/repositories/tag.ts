import { generateUlid } from '../utils/ulid';

export type Tag = {
	id: string;
	name: string;
	display_name: string | null;
	usable: number;
	trendable: number;
	listable: number;
	last_status_at: string | null;
	created_at: string;
	updated_at: string;
};

export const findByName = async (db: D1Database, name: string): Promise<Tag | null> => {
	const result = await db
		.prepare('SELECT * FROM tags WHERE name = ?')
		.bind(name.toLowerCase())
		.first<Tag>();
	return result ?? null;
};

export const findOrCreate = async (db: D1Database, name: string): Promise<Tag> => {
	const normalizedName = name.toLowerCase();
	const existing = await findByName(db, normalizedName);
	if (existing) return existing;

	const now = new Date().toISOString();
	const id = generateUlid();
	const tag: Tag = {
		id,
		name: normalizedName,
		display_name: name,
		usable: 1,
		trendable: 1,
		listable: 1,
		last_status_at: null,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO tags (id, name, display_name, usable, trendable, listable, last_status_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			tag.id, tag.name, tag.display_name,
			tag.usable, tag.trendable, tag.listable,
			tag.last_status_at, tag.created_at, tag.updated_at
		)
		.run();

	return tag;
};

export const findByStatusId = async (db: D1Database, statusId: string): Promise<Tag[]> => {
	const { results } = await db
		.prepare(
			`SELECT t.* FROM tags t
			 JOIN status_tags st ON st.tag_id = t.id
			 WHERE st.status_id = ?
			 ORDER BY t.name ASC`
		)
		.bind(statusId)
		.all<Tag>();
	return results;
};

export const addToStatus = async (db: D1Database, statusId: string, tagIds: string[]): Promise<void> => {
	if (tagIds.length === 0) return;

	const stmts = tagIds.map((tagId) =>
		db
			.prepare('INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES (?, ?)')
			.bind(statusId, tagId)
	);

	await db.batch(stmts);
};
