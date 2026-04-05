import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
import type { AccountRow, FollowRow, FollowRequestRow, BlockRow, MuteRow } from '../types/db';
import type { Relationship } from '../types/mastodon';

// ----------------------------------------------------------------
// Get account by ID
// ----------------------------------------------------------------

export async function getAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
	return (await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first()) as AccountRow | null;
}

// ----------------------------------------------------------------
// Get account by username and optional domain
// ----------------------------------------------------------------

export async function getAccountByUsername(
	db: D1Database,
	username: string,
	domain?: string | null,
): Promise<AccountRow | null> {
	if (domain) {
		return (await db
			.prepare('SELECT * FROM accounts WHERE username = ? AND domain = ? LIMIT 1')
			.bind(username.toLowerCase(), domain.toLowerCase())
			.first()) as AccountRow | null;
	}
	return (await db
		.prepare('SELECT * FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
		.bind(username.toLowerCase())
		.first()) as AccountRow | null;
}

// ----------------------------------------------------------------
// Update profile
// ----------------------------------------------------------------

export async function updateProfile(
	db: D1Database,
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
		return (await getAccountById(db, accountId))!;
	}

	sets.push('updated_at = ?');
	values.push(new Date().toISOString());
	values.push(accountId);

	await db
		.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return (await getAccountById(db, accountId))!;
}

// ----------------------------------------------------------------
// Get relationship between two accounts
// ----------------------------------------------------------------

export async function getRelationship(db: D1Database, accountId: string, targetId: string): Promise<Relationship> {
	const [follow, followedBy, followReq, followReqBy, block, blockedBy, mute] = await Promise.all([
		db
			.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first() as Promise<FollowRow | null>,
		db
			.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(targetId, accountId)
			.first() as Promise<FollowRow | null>,
		db
			.prepare('SELECT * FROM follow_requests WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first() as Promise<FollowRequestRow | null>,
		db
			.prepare('SELECT * FROM follow_requests WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(targetId, accountId)
			.first() as Promise<FollowRequestRow | null>,
		db
			.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first() as Promise<BlockRow | null>,
		db
			.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(targetId, accountId)
			.first() as Promise<BlockRow | null>,
		db
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
		domain_blocking: false,
		endorsed: false,
		note: '',
		languages: follow?.languages ? JSON.parse(follow.languages) : null,
	};
}

// ----------------------------------------------------------------
// Get batch relationships
// ----------------------------------------------------------------

export async function getRelationships(
	db: D1Database,
	accountId: string,
	targetIds: string[],
): Promise<Relationship[]> {
	return Promise.all(targetIds.map((targetId) => getRelationship(db, accountId, targetId)));
}

// ----------------------------------------------------------------
// Search accounts
// ----------------------------------------------------------------

export async function searchAccounts(
	db: D1Database,
	query: string,
	limit: number = 40,
	offset: number = 0,
	options?: { followedBy?: string },
): Promise<AccountRow[]> {
	const searchTerm = `%${query}%`;

	if (options?.followedBy) {
		const results = await db
			.prepare(
				`SELECT a.* FROM accounts a
				JOIN follows f ON f.target_account_id = a.id
				WHERE f.account_id = ?
					AND (a.username LIKE ? OR a.display_name LIKE ?)
				ORDER BY a.username ASC
				LIMIT ? OFFSET ?`,
			)
			.bind(options.followedBy, searchTerm, searchTerm, limit, offset)
			.all();

		return (results.results || []) as unknown as AccountRow[];
	}

	const results = await db
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
// Create follow (or follow request)
// ----------------------------------------------------------------

export interface CreateFollowResult {
	type: 'follow' | 'follow_request';
	id: string;
	uri: string;
}

export async function createFollow(
	db: D1Database,
	domain: string,
	accountId: string,
	target: { id: string; domain: string | null; locked: number; manually_approves_followers: number },
): Promise<CreateFollowResult> {
	if (accountId === target.id) {
		throw new AppError(422, 'Validation failed', 'You cannot follow yourself');
	}

	// Check existing follow
	const existingFollow = await db
		.prepare('SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, target.id)
		.first();
	if (existingFollow) {
		return { type: 'follow', id: existingFollow.id as string, uri: '' };
	}

	// Check existing follow request
	const existingRequest = await db
		.prepare('SELECT id FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, target.id)
		.first();
	if (existingRequest) {
		return { type: 'follow_request', id: existingRequest.id as string, uri: '' };
	}

	const now = new Date().toISOString();
	const id = generateUlid();
	const isRemote = !!target.domain;
	const needsApproval = !!(target.locked || target.manually_approves_followers);

	if (isRemote || needsApproval) {
		const followActivityId = `https://${domain}/activities/${generateUlid()}`;

		await db
			.prepare(
				`INSERT INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
			)
			.bind(id, accountId, target.id, followActivityId, now)
			.run();

		return { type: 'follow_request', id, uri: followActivityId };
	}

	// Local non-locked account: auto-accept immediately
	const followUri = `https://${domain}/activities/${generateUlid()}`;

	await db.batch([
		db
			.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)`,
			)
			.bind(id, accountId, target.id, followUri, now),
		db.prepare('UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1').bind(accountId),
		db.prepare('UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1').bind(target.id),
	]);

	return { type: 'follow', id, uri: followUri };
}

// ----------------------------------------------------------------
// Remove follow
// ----------------------------------------------------------------

export interface RemoveFollowResult {
	/** The deleted follow row (id + uri), or null if no follow existed */
	deletedFollow: { id: string; uri: string | null } | null;
	/** The deleted follow request row (id + uri), or null if none existed */
	deletedFollowRequest: { id: string; uri: string | null } | null;
}

export async function removeFollow(
	db: D1Database,
	accountId: string,
	targetId: string,
): Promise<RemoveFollowResult> {
	const follow = await db
		.prepare('SELECT id, uri FROM follows WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	let deletedFollow: RemoveFollowResult['deletedFollow'] = null;

	if (follow) {
		await db.batch([
			db.prepare('DELETE FROM follows WHERE id = ?1').bind(follow.id as string),
			db.prepare('UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1').bind(accountId),
			db.prepare('UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1').bind(targetId),
		]);
		deletedFollow = { id: follow.id as string, uri: (follow.uri as string | null) };
	}

	// Also remove any pending follow request
	const fr = await db
		.prepare('SELECT id, uri FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	let deletedFollowRequest: RemoveFollowResult['deletedFollowRequest'] = null;

	if (fr) {
		await db.prepare('DELETE FROM follow_requests WHERE id = ?1').bind(fr.id as string).run();
		deletedFollowRequest = { id: fr.id as string, uri: (fr.uri as string | null) };
	}

	return { deletedFollow, deletedFollowRequest };
}

// ----------------------------------------------------------------
// Create block
// ----------------------------------------------------------------

export async function createBlock(
	db: D1Database,
	accountId: string,
	targetId: string,
): Promise<void> {
	if (accountId === targetId) {
		throw new AppError(422, 'Validation failed', 'You cannot block yourself');
	}

	const existing = await db
		.prepare('SELECT id FROM blocks WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	if (!existing) {
		const now = new Date().toISOString();
		const id = generateUlid();

		// Block and remove any existing follows in both directions
		await db.batch([
			db
				.prepare('INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)')
				.bind(id, accountId, targetId, now),
			db.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(accountId, targetId),
			db.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, accountId),
			db.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(accountId, targetId),
			db.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, accountId),
		]);
	}
}

// ----------------------------------------------------------------
// Remove block
// ----------------------------------------------------------------

export async function removeBlock(db: D1Database, accountId: string, targetId: string): Promise<void> {
	await db
		.prepare('DELETE FROM blocks WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.run();
}

// ----------------------------------------------------------------
// Create mute
// ----------------------------------------------------------------

export async function createMute(
	db: D1Database,
	accountId: string,
	targetId: string,
	notifications: boolean = true,
	expiresAt: string | null = null,
): Promise<void> {
	if (accountId === targetId) {
		throw new AppError(422, 'Validation failed', 'You cannot mute yourself');
	}

	const hideNotifications = notifications ? 1 : 0;
	const now = new Date().toISOString();

	const existing = await db
		.prepare('SELECT id FROM mutes WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	if (existing) {
		await db
			.prepare('UPDATE mutes SET hide_notifications = ?1, expires_at = ?2, updated_at = ?3 WHERE id = ?4')
			.bind(hideNotifications, expiresAt, now, existing.id as string)
			.run();
	} else {
		const id = generateUlid();
		await db
			.prepare(
				`INSERT INTO mutes (id, account_id, target_account_id, hide_notifications, expires_at, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
			)
			.bind(id, accountId, targetId, hideNotifications, expiresAt, now)
			.run();
	}
}

// ----------------------------------------------------------------
// Remove mute
// ----------------------------------------------------------------

export async function removeMute(db: D1Database, accountId: string, targetId: string): Promise<void> {
	await db
		.prepare('DELETE FROM mutes WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.run();
}
