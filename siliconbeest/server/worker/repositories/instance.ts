import { generateUlid } from '../utils/ulid';

export type Instance = {
	id: string;
	domain: string;
	software_name: string | null;
	software_version: string | null;
	title: string | null;
	description: string | null;
	inbox_url: string | null;
	public_key: string | null;
	last_successful_at: string | null;
	last_failed_at: string | null;
	failure_count: number;
	created_at: string;
	updated_at: string;
};

export type UpsertInstanceInput = {
	software_name?: string | null;
	software_version?: string | null;
	title?: string | null;
	description?: string | null;
	inbox_url?: string | null;
	public_key?: string | null;
};

export const findByDomain = async (
	db: D1Database,
	domain: string,
): Promise<Instance | null> => {
	const result = await db
		.prepare('SELECT * FROM instances WHERE domain = ?')
		.bind(domain)
		.first<Instance>();
	return result ?? null;
};

export const upsert = async (
	db: D1Database,
	domain: string,
	data: UpsertInstanceInput,
): Promise<Instance> => {
	const now = new Date().toISOString();
	const existing = await findByDomain(db, domain);

	if (existing) {
		const entries = Object.entries(data).filter(([, value]) => value !== undefined);
		const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
		const values = [...entries.map(([, value]) => value), now, existing.id];

		await db
			.prepare(`UPDATE instances SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return (await findByDomain(db, domain))!;
	}

	const id = generateUlid();
	const instance: Instance = {
		id,
		domain,
		software_name: data.software_name ?? null,
		software_version: data.software_version ?? null,
		title: data.title ?? null,
		description: data.description ?? null,
		inbox_url: data.inbox_url ?? null,
		public_key: data.public_key ?? null,
		last_successful_at: null,
		last_failed_at: null,
		failure_count: 0,
		created_at: now,
		updated_at: now,
	};

	await db
		.prepare(
			`INSERT INTO instances (
				id, domain, software_name, software_version, title, description,
				inbox_url, public_key, last_successful_at, last_failed_at,
				failure_count, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			instance.id, instance.domain, instance.software_name,
			instance.software_version, instance.title, instance.description,
			instance.inbox_url, instance.public_key,
			instance.last_successful_at, instance.last_failed_at,
			instance.failure_count, instance.created_at, instance.updated_at
		)
		.run();

	return instance;
};

export const updateFailure = async (
	db: D1Database,
	domain: string,
): Promise<void> => {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE instances SET
				last_failed_at = ?,
				failure_count = failure_count + 1,
				updated_at = ?
			 WHERE domain = ?`
		)
		.bind(now, now, domain)
		.run();
};

export const updateSuccess = async (
	db: D1Database,
	domain: string,
): Promise<void> => {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE instances SET
				last_successful_at = ?,
				failure_count = 0,
				updated_at = ?
			 WHERE domain = ?`
		)
		.bind(now, now, domain)
		.run();
};
