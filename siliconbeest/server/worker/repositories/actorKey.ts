import { generateUlid } from '../utils/ulid';

export interface ActorKey {
	id: string;
	account_id: string;
	public_key: string;
	private_key: string;
	key_id: string;
	created_at: string;
}

export interface CreateActorKeyInput {
	account_id: string;
	public_key: string;
	private_key: string;
	key_id: string;
}

export class ActorKeyRepository {
	constructor(private db: D1Database) {}

	async findByAccountId(accountId: string): Promise<ActorKey | null> {
		const result = await this.db
			.prepare('SELECT * FROM actor_keys WHERE account_id = ?')
			.bind(accountId)
			.first<ActorKey>();
		return result ?? null;
	}

	async create(input: CreateActorKeyInput): Promise<ActorKey> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const actorKey: ActorKey = {
			id,
			account_id: input.account_id,
			public_key: input.public_key,
			private_key: input.private_key,
			key_id: input.key_id,
			created_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(
				actorKey.id, actorKey.account_id,
				actorKey.public_key, actorKey.private_key,
				actorKey.key_id, actorKey.created_at
			)
			.run();

		return actorKey;
	}
}
