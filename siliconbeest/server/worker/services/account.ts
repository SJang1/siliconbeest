import { generateUlid } from '../utils/ulid';
import type { AccountRow, FollowRow, FollowRequestRow, BlockRow, MuteRow } from '../types/db';
import type { Relationship } from '../types/mastodon';

/**
 * Account service: profile management, relationships (follow/block/mute),
 * and account search.
 */
export class AccountService {
	constructor(
		private db: D1Database,
		private domain: string,
	) {}

	// ----------------------------------------------------------------
	// Get account by ID
	// ----------------------------------------------------------------
	async getById(id: string): Promise<AccountRow | null> {
		return (await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first()) as AccountRow | null;
	}

	// ----------------------------------------------------------------
	// Get account by username and domain
	// ----------------------------------------------------------------
	async getByUsername(username: string, domain?: string | null): Promise<AccountRow | null> {
		if (domain) {
			return (await this.db
				.prepare('SELECT * FROM accounts WHERE username = ? AND domain = ? LIMIT 1')
				.bind(username.toLowerCase(), domain.toLowerCase())
				.first()) as AccountRow | null;
		}
		return (await this.db
			.prepare('SELECT * FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
			.bind(username.toLowerCase())
			.first()) as AccountRow | null;
	}

	// ----------------------------------------------------------------
	// Update profile
	// ----------------------------------------------------------------
	async updateProfile(
		accountId: string,
		data: {
			displayName?: string;
			note?: string;
			locked?: boolean;
			bot?: boolean;
			discoverable?: boolean;
		},
	): Promise<AccountRow> {
		const sets: string[] = [];
		const values: (string | number)[] = [];

		if (data.displayName !== undefined) {
			sets.push('display_name = ?');
			values.push(data.displayName);
		}
		if (data.note !== undefined) {
			sets.push('note = ?');
			values.push(data.note);
		}
		if (data.locked !== undefined) {
			sets.push('locked = ?');
			sets.push('manually_approves_followers = ?');
			values.push(data.locked ? 1 : 0);
			values.push(data.locked ? 1 : 0);
		}
		if (data.bot !== undefined) {
			sets.push('bot = ?');
			values.push(data.bot ? 1 : 0);
		}
		if (data.discoverable !== undefined) {
			sets.push('discoverable = ?');
			values.push(data.discoverable ? 1 : 0);
		}

		if (sets.length === 0) {
			return (await this.getById(accountId))!;
		}

		sets.push('updated_at = ?');
		values.push(new Date().toISOString());
		values.push(accountId);

		await this.db
			.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		return (await this.getById(accountId))!;
	}

	// ----------------------------------------------------------------
	// Get relationship between two accounts
	// ----------------------------------------------------------------
	async getRelationship(accountId: string, targetId: string): Promise<Relationship> {
		const [follow, followedBy, followReq, followReqBy, block, blockedBy, mute] = await Promise.all([
			this.db
				.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(accountId, targetId)
				.first() as Promise<FollowRow | null>,
			this.db
				.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(targetId, accountId)
				.first() as Promise<FollowRow | null>,
			this.db
				.prepare('SELECT * FROM follow_requests WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(accountId, targetId)
				.first() as Promise<FollowRequestRow | null>,
			this.db
				.prepare('SELECT * FROM follow_requests WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(targetId, accountId)
				.first() as Promise<FollowRequestRow | null>,
			this.db
				.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(accountId, targetId)
				.first() as Promise<BlockRow | null>,
			this.db
				.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(targetId, accountId)
				.first() as Promise<BlockRow | null>,
			this.db
				.prepare('SELECT * FROM mutes WHERE account_id = ? AND target_account_id = ? LIMIT 1')
				.bind(accountId, targetId)
				.first() as Promise<MuteRow | null>,
		]);

		return {
			id: targetId,
			following: !!follow,
			showing_reblogs: follow ? !!follow.show_reblogs : false,
			notifying: follow ? !!follow.notify : false,
			followed_by: !!followedBy,
			blocking: !!block,
			blocked_by: !!blockedBy,
			muting: !!mute,
			muting_notifications: mute ? !!mute.hide_notifications : false,
			requested: !!followReq,
			requested_by: !!followReqBy,
			domain_blocking: false, // TODO: implement domain blocking check
			endorsed: false,
			note: '',
			languages: follow?.languages ? JSON.parse(follow.languages) : null,
		};
	}

	// ----------------------------------------------------------------
	// Get batch relationships
	// ----------------------------------------------------------------
	async getRelationships(accountId: string, targetIds: string[]): Promise<Relationship[]> {
		return Promise.all(targetIds.map((targetId) => this.getRelationship(accountId, targetId)));
	}

	// ----------------------------------------------------------------
	// Search accounts
	// ----------------------------------------------------------------
	async search(query: string, limit: number = 40, offset: number = 0, _resolve: boolean = false): Promise<AccountRow[]> {
		const searchTerm = `%${query}%`;
		const results = await this.db
			.prepare(
				`SELECT * FROM accounts
				WHERE (username LIKE ? OR display_name LIKE ?)
				AND suspended_at IS NULL
				ORDER BY
					CASE WHEN domain IS NULL THEN 0 ELSE 1 END,
					followers_count DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(searchTerm, searchTerm, limit, offset)
			.all();

		return (results.results || []) as unknown as AccountRow[];
	}

	// ----------------------------------------------------------------
	// Follow
	// ----------------------------------------------------------------
	async follow(accountId: string, targetId: string): Promise<Relationship> {
		if (accountId === targetId) {
			throw new Error('Cannot follow yourself');
		}

		const target = await this.getById(targetId);
		if (!target) {
			throw new Error('Account not found');
		}

		// Check if already following
		const existingFollow = await this.db
			.prepare('SELECT id FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();
		if (existingFollow) {
			return this.getRelationship(accountId, targetId);
		}

		// Check if already requested
		const existingRequest = await this.db
			.prepare('SELECT id FROM follow_requests WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();
		if (existingRequest) {
			return this.getRelationship(accountId, targetId);
		}

		const now = new Date().toISOString();
		const id = generateUlid();

		if (target.locked) {
			// Create follow request
			await this.db
				.prepare(
					`INSERT INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
					VALUES (?, ?, ?, NULL, ?, ?)`,
				)
				.bind(id, accountId, targetId, now, now)
				.run();
		} else {
			// Create follow directly
			const uri = target.domain ? null : `https://${this.domain}/users/${accountId}/follows/${id}`;
			await this.db
				.prepare(
					`INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, languages, created_at, updated_at)
					VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
				)
				.bind(id, accountId, targetId, uri, now, now)
				.run();

			// Update counts
			await this.db.batch([
				this.db.prepare('UPDATE accounts SET following_count = following_count + 1, updated_at = ? WHERE id = ?').bind(now, accountId),
				this.db.prepare('UPDATE accounts SET followers_count = followers_count + 1, updated_at = ? WHERE id = ?').bind(now, targetId),
			]);
		}

		return this.getRelationship(accountId, targetId);
	}

	// ----------------------------------------------------------------
	// Unfollow
	// ----------------------------------------------------------------
	async unfollow(accountId: string, targetId: string): Promise<Relationship> {
		const now = new Date().toISOString();

		// Remove follow
		const follow = await this.db
			.prepare('SELECT id FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();

		if (follow) {
			await this.db
				.prepare('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?')
				.bind(accountId, targetId)
				.run();

			await this.db.batch([
				this.db
					.prepare('UPDATE accounts SET following_count = MAX(following_count - 1, 0), updated_at = ? WHERE id = ?')
					.bind(now, accountId),
				this.db
					.prepare('UPDATE accounts SET followers_count = MAX(followers_count - 1, 0), updated_at = ? WHERE id = ?')
					.bind(now, targetId),
			]);
		}

		// Also remove any pending follow request
		await this.db
			.prepare('DELETE FROM follow_requests WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetId)
			.run();

		return this.getRelationship(accountId, targetId);
	}

	// ----------------------------------------------------------------
	// Block
	// ----------------------------------------------------------------
	async block(accountId: string, targetId: string): Promise<Relationship> {
		if (accountId === targetId) {
			throw new Error('Cannot block yourself');
		}

		// Remove any existing follow in both directions
		await this.unfollow(accountId, targetId);

		// Remove reverse follow if exists
		const reverseFollow = await this.db
			.prepare('SELECT id FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(targetId, accountId)
			.first();
		if (reverseFollow) {
			const now = new Date().toISOString();
			await this.db
				.prepare('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?')
				.bind(targetId, accountId)
				.run();
			await this.db.batch([
				this.db
					.prepare('UPDATE accounts SET following_count = MAX(following_count - 1, 0), updated_at = ? WHERE id = ?')
					.bind(now, targetId),
				this.db
					.prepare('UPDATE accounts SET followers_count = MAX(followers_count - 1, 0), updated_at = ? WHERE id = ?')
					.bind(now, accountId),
			]);
		}

		// Check if already blocked
		const existingBlock = await this.db
			.prepare('SELECT id FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();

		if (!existingBlock) {
			const id = generateUlid();
			const now = new Date().toISOString();
			await this.db
				.prepare('INSERT INTO blocks (id, account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, NULL, ?)')
				.bind(id, accountId, targetId, now)
				.run();
		}

		return this.getRelationship(accountId, targetId);
	}

	// ----------------------------------------------------------------
	// Unblock
	// ----------------------------------------------------------------
	async unblock(accountId: string, targetId: string): Promise<Relationship> {
		await this.db
			.prepare('DELETE FROM blocks WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetId)
			.run();

		return this.getRelationship(accountId, targetId);
	}

	// ----------------------------------------------------------------
	// Mute
	// ----------------------------------------------------------------
	async mute(accountId: string, targetId: string, notifications: boolean = true): Promise<Relationship> {
		if (accountId === targetId) {
			throw new Error('Cannot mute yourself');
		}

		// Check if already muted
		const existingMute = await this.db
			.prepare('SELECT id FROM mutes WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();

		const now = new Date().toISOString();

		if (existingMute) {
			// Update notification setting
			await this.db
				.prepare('UPDATE mutes SET hide_notifications = ?, updated_at = ? WHERE account_id = ? AND target_account_id = ?')
				.bind(notifications ? 1 : 0, now, accountId, targetId)
				.run();
		} else {
			const id = generateUlid();
			await this.db
				.prepare(
					`INSERT INTO mutes (id, account_id, target_account_id, hide_notifications, expires_at, created_at, updated_at)
					VALUES (?, ?, ?, ?, NULL, ?, ?)`,
				)
				.bind(id, accountId, targetId, notifications ? 1 : 0, now, now)
				.run();
		}

		return this.getRelationship(accountId, targetId);
	}

	// ----------------------------------------------------------------
	// Unmute
	// ----------------------------------------------------------------
	async unmute(accountId: string, targetId: string): Promise<Relationship> {
		await this.db
			.prepare('DELETE FROM mutes WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetId)
			.run();

		return this.getRelationship(accountId, targetId);
	}
}
