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
	const [follow, followedBy, followReq, followReqBy, block, blockedBy, mute, targetAccount] = await Promise.all([
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
		db
			.prepare('SELECT domain FROM accounts WHERE id = ? LIMIT 1')
			.bind(targetId)
			.first<{ domain: string | null }>(),
	]);

	// Queries for tables added in migration 0023 (graceful fallback)
	let endorsed = false;
	let noteComment = '';
	let domainBlocking = false;
	try {
		const [endorsedRow, accountNote] = await Promise.all([
			db
				.prepare('SELECT id FROM account_pins WHERE account_id = ? AND target_account_id = ?')
				.bind(accountId, targetId)
				.first(),
			db
				.prepare('SELECT comment FROM account_notes WHERE account_id = ? AND target_account_id = ?')
				.bind(accountId, targetId)
				.first<{ comment: string }>(),
		]);
		endorsed = !!endorsedRow;
		noteComment = accountNote?.comment ?? '';

		if (targetAccount?.domain) {
			const dbRow = await db
				.prepare('SELECT id FROM user_domain_blocks WHERE account_id = ? AND domain = ?')
				.bind(accountId, targetAccount.domain)
				.first();
			domainBlocking = !!dbRow;
		}
	} catch {
		// Tables may not exist yet (pre-migration 0023)
	}

	return {
		id: targetId,
		following: !!follow,
		showing_reblogs: follow ? !!follow.show_reblogs : true,
		notifying: follow ? !!follow.notify : false,
		followed_by: !!followedBy,
		blocking: !!block,
		blocked_by: !!blockedBy,
		muting: !!mute,
		muting_notifications: mute ? !!mute.hide_notifications : false,
		requested: !!followReq,
		requested_by: !!followReqBy,
		domain_blocking: domainBlocking,
		endorsed,
		note: noteComment,
		languages: (() => { try { return follow?.languages ? JSON.parse(follow.languages) : null; } catch { return null; } })(),
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

// ----------------------------------------------------------------
// Accept follow request
// ----------------------------------------------------------------

export interface AcceptFollowRequestResult {
	followId: string;
	followUri: string;
	/** The original follow_request row (including uri for federation) */
	followRequest: Record<string, unknown>;
}

export async function acceptFollowRequest(
	db: D1Database,
	domain: string,
	accountId: string,
	targetAccountId: string,
): Promise<AcceptFollowRequestResult> {
	const fr = await db
		.prepare('SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetAccountId)
		.first();

	if (!fr) {
		throw new AppError(404, 'Record not found');
	}

	const now = new Date().toISOString();
	const followId = generateUlid();

	// Look up the target account's username for the follow URI
	const targetAccount = await db
		.prepare('SELECT username FROM accounts WHERE id = ?1')
		.bind(targetAccountId)
		.first<{ username: string }>();
	const targetUsername = targetAccount?.username ?? 'unknown';
	const followUri = `https://${domain}/users/${targetUsername}/followers/${followId}`;

	await db.batch([
		// Create the follow
		db.prepare(
			`INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, languages, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 1, 0, NULL, ?5, ?5)`,
		).bind(followId, accountId, targetAccountId, followUri, now),
		// Update follower/following counts
		db.prepare(
			'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1',
		).bind(accountId),
		db.prepare(
			'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1',
		).bind(targetAccountId),
		// Remove the follow request
		db.prepare(
			'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
		).bind(accountId, targetAccountId),
	]);

	return { followId, followUri, followRequest: fr as Record<string, unknown> };
}

// ----------------------------------------------------------------
// Reject follow request
// ----------------------------------------------------------------

export interface RejectFollowRequestResult {
	/** The original follow_request row (including uri for federation) */
	followRequest: Record<string, unknown>;
}

export async function rejectFollowRequest(
	db: D1Database,
	accountId: string,
	targetAccountId: string,
): Promise<RejectFollowRequestResult> {
	const fr = await db
		.prepare('SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetAccountId)
		.first();

	if (!fr) {
		throw new AppError(404, 'Record not found');
	}

	await db
		.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetAccountId)
		.run();

	return { followRequest: fr as Record<string, unknown> };
}

// ----------------------------------------------------------------
// Set personal note on account
// ----------------------------------------------------------------

export async function setAccountNote(
	db: D1Database,
	accountId: string,
	targetId: string,
	comment: string,
): Promise<void> {
	const target = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
	if (!target) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	if (comment) {
		await db
			.prepare(
				`INSERT INTO account_notes (id, account_id, target_account_id, comment, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				 ON CONFLICT(account_id, target_account_id) DO UPDATE SET comment = ?4, updated_at = ?6`,
			)
			.bind(generateUlid(), accountId, targetId, comment, now, now)
			.run();
	} else {
		await db
			.prepare('DELETE FROM account_notes WHERE account_id = ?1 AND target_account_id = ?2')
			.bind(accountId, targetId)
			.run();
	}
}

// ----------------------------------------------------------------
// Pin (endorse) account
// ----------------------------------------------------------------

export async function pinAccount(
	db: D1Database,
	accountId: string,
	targetId: string,
): Promise<void> {
	const target = await db.prepare('SELECT * FROM accounts WHERE id = ?1').bind(targetId).first();
	if (!target) throw new AppError(404, 'Record not found');

	// Must be following to endorse
	const follow = await db
		.prepare('SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();
	if (!follow) throw new AppError(422, 'Validation failed: you must be following this account to endorse it');

	const existing = await db
		.prepare('SELECT id FROM account_pins WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	if (!existing) {
		const now = new Date().toISOString();
		await db
			.prepare('INSERT INTO account_pins (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)')
			.bind(generateUlid(), accountId, targetId, now)
			.run();
	}
}

// ----------------------------------------------------------------
// Unpin (remove endorsement) account
// ----------------------------------------------------------------

export async function unpinAccount(
	db: D1Database,
	accountId: string,
	targetId: string,
): Promise<void> {
	await db
		.prepare('DELETE FROM account_pins WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.run();
}

// ----------------------------------------------------------------
// Aliases (alsoKnownAs)
// ----------------------------------------------------------------

/**
 * Get the also_known_as aliases for an account.
 */
export async function getAliases(db: D1Database, accountId: string): Promise<string[]> {
	const account = await db.prepare(
		'SELECT also_known_as FROM accounts WHERE id = ?1 LIMIT 1',
	).bind(accountId).first<{ also_known_as: string | null }>();

	if (!account) throw new AppError(404, 'Account not found');

	if (!account.also_known_as) return [];
	const parsed = JSON.parse(account.also_known_as);
	return Array.isArray(parsed) ? parsed : [];
}

/**
 * Add an alias to an account's also_known_as list.
 * Returns the updated alias list.
 */
export async function addAlias(db: D1Database, accountId: string, actorUri: string): Promise<string[]> {
	const aliases = await getAliases(db, accountId);

	if (aliases.includes(actorUri)) return aliases;

	aliases.push(actorUri);

	const now = new Date().toISOString();
	await db.prepare(
		'UPDATE accounts SET also_known_as = ?1, updated_at = ?2 WHERE id = ?3',
	).bind(JSON.stringify(aliases), now, accountId).run();

	return aliases;
}

/**
 * Remove an alias from an account's also_known_as list.
 * Returns the updated alias list.
 */
export async function removeAlias(db: D1Database, accountId: string, alias: string): Promise<string[]> {
	const aliases = await getAliases(db, accountId);
	const filtered = aliases.filter((a) => a !== alias);

	const now = new Date().toISOString();
	await db.prepare(
		'UPDATE accounts SET also_known_as = ?1, updated_at = ?2 WHERE id = ?3',
	).bind(filtered.length > 0 ? JSON.stringify(filtered) : null, now, accountId).run();

	return filtered;
}

// ----------------------------------------------------------------
// Migration
// ----------------------------------------------------------------

/**
 * Get account URI and username for migration verification.
 */
export async function getAccountUri(
	db: D1Database,
	accountId: string,
): Promise<{ username: string; uri: string } | null> {
	return db.prepare(
		'SELECT username, uri FROM accounts WHERE id = ?1 LIMIT 1',
	).bind(accountId).first<{ username: string; uri: string }>();
}

/**
 * Set the moved_to_account_id on an account for migration.
 */
export async function setMovedTo(
	db: D1Database,
	accountId: string,
	targetAccountId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		'UPDATE accounts SET moved_to_account_id = ?1, moved_at = ?2, updated_at = ?3 WHERE id = ?4',
	).bind(targetAccountId, now, now, accountId).run();
}

// ----------------------------------------------------------------
// Export queries
// ----------------------------------------------------------------

/**
 * Get following accounts for CSV export.
 */
export async function getFollowingForExport(
	db: D1Database,
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await db.prepare(
		`SELECT a.username, a.domain
		 FROM follows f
		 JOIN accounts a ON a.id = f.target_account_id
		 WHERE f.account_id = ?`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ username: string; domain: string | null }>;
}

/**
 * Get followers for CSV export.
 */
export async function getFollowersForExport(
	db: D1Database,
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await db.prepare(
		`SELECT a.username, a.domain
		 FROM follows f
		 JOIN accounts a ON a.id = f.account_id
		 WHERE f.target_account_id = ?`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ username: string; domain: string | null }>;
}

/**
 * Get blocked accounts for CSV export.
 */
export async function getBlocksForExport(
	db: D1Database,
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await db.prepare(
		`SELECT a.username, a.domain
		 FROM blocks bl
		 JOIN accounts a ON a.id = bl.target_account_id
		 WHERE bl.account_id = ?`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ username: string; domain: string | null }>;
}

/**
 * Get muted accounts for CSV export.
 */
export async function getMutesForExport(
	db: D1Database,
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await db.prepare(
		`SELECT a.username, a.domain
		 FROM mutes m
		 JOIN accounts a ON a.id = m.target_account_id
		 WHERE m.account_id = ?`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ username: string; domain: string | null }>;
}

/**
 * Get bookmarked status URIs for CSV export.
 */
export async function getBookmarksForExport(
	db: D1Database,
	accountId: string,
): Promise<string[]> {
	const { results } = await db.prepare(
		`SELECT s.uri
		 FROM bookmarks b
		 JOIN statuses s ON s.id = b.status_id
		 WHERE b.account_id = ?`,
	).bind(accountId).all();
	return (results ?? []).map((r: any) => r.uri as string);
}

/**
 * Get list memberships for CSV export.
 */
export async function getListsForExport(
	db: D1Database,
	accountId: string,
): Promise<Array<{ title: string; username: string; domain: string | null }>> {
	const { results } = await db.prepare(
		`SELECT l.title, a.username, a.domain
		 FROM lists l
		 JOIN list_accounts la ON la.list_id = l.id
		 JOIN accounts a ON a.id = la.account_id
		 WHERE l.account_id = ?
		 ORDER BY l.title ASC`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ title: string; username: string; domain: string | null }>;
}
