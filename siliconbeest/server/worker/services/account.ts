import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
import type { AccountRow, FollowRequestRow } from '../types/db';
import type { Relationship } from '../types/mastodon';
import { canViewAccountRelationship } from '../../../../packages/shared/permissions';
import {
	assertAccountFeatureable,
	assertAccountRelationshipMutable,
	assertFollowRequestActionable,
	buildActionableFollowRequestSqlPredicate,
	buildAccountSearchSqlPredicate,
} from './permissions';

// ----------------------------------------------------------------
// Get account by ID
// ----------------------------------------------------------------

export async function getAccountById(id: string): Promise<AccountRow | null> {
	return (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first()) as AccountRow | null;
}

// ----------------------------------------------------------------
// Get account by username and optional domain
// ----------------------------------------------------------------

export async function getAccountByUsername(
	username: string,
	domain?: string | null,
): Promise<AccountRow | null> {
	if (domain) {
		return (await env.DB
			.prepare('SELECT * FROM accounts WHERE username = ? AND domain = ? LIMIT 1')
			.bind(username, domain.toLowerCase())
			.first()) as AccountRow | null;
	}
	// Local account lookups are case-sensitive (exact match), consistent with
	// ActivityPub identity. Case-insensitive matching is reserved for auth flows
	// (login / password reset); see services/auth.ts.
	return (await env.DB
		.prepare('SELECT * FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
		.bind(username)
		.first()) as AccountRow | null;
}

// ----------------------------------------------------------------
// Update profile
// ----------------------------------------------------------------

export async function updateProfile(
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
		return (await getAccountById(accountId))!;
	}

	sets.push('updated_at = ?');
	values.push(new Date().toISOString());
	values.push(accountId);

	await env.DB
		.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return (await getAccountById(accountId))!;
}

// ----------------------------------------------------------------
// Get relationship between two accounts
// ----------------------------------------------------------------

const RELATIONSHIP_QUERY_BATCH_SIZE = 50;

interface RelationshipBaseRow {
	target_id: string;
	target_suspended_at: string | null;
	outgoing_follow_id: string | null;
	outgoing_show_reblogs: number | null;
	outgoing_notify: number | null;
	outgoing_languages: string | null;
	incoming_follow_id: string | null;
	outgoing_request_id: string | null;
	incoming_request_id: string | null;
	outgoing_block_id: string | null;
	incoming_block_id: string | null;
	outgoing_mute_id: string | null;
	outgoing_mute_notifications: number | null;
}

interface RelationshipOptionalRow {
	target_id: string;
	endorsement_id: string | null;
	note_comment: string | null;
	domain_blocking: number;
}

interface RelationshipState extends RelationshipBaseRow {
	endorsed: boolean;
	note: string;
	domainBlocking: boolean;
}

function parseRelationshipLanguages(value: string | null | undefined): string[] | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((language) => typeof language === 'string')
			? parsed
			: null;
	} catch {
		return null;
	}
}

function buildRelationship(
	targetId: string,
	state: RelationshipState | null,
): Relationship {
	const followState = state?.outgoing_follow_id != null ? state : null;
	const muteState = state?.outgoing_mute_id != null ? state : null;
	return {
		id: targetId,
		following: followState !== null,
		showing_reblogs: followState ? followState.outgoing_show_reblogs !== 0 : true,
		notifying: followState ? followState.outgoing_notify !== 0 : false,
		followed_by: state?.incoming_follow_id != null,
		blocking: state?.outgoing_block_id != null,
		blocked_by: state?.incoming_block_id != null,
		muting: muteState !== null,
		muting_notifications: muteState ? muteState.outgoing_mute_notifications !== 0 : false,
		requested: state?.outgoing_request_id != null,
		requested_by: state?.incoming_request_id != null,
		domain_blocking: state?.domainBlocking ?? false,
		endorsed: state?.endorsed ?? false,
		note: state?.note ?? '',
		languages: parseRelationshipLanguages(state?.outgoing_languages),
	};
}

async function fetchRelationshipBaseRows(
	accountId: string,
	targetIds: string[],
	now: string,
): Promise<RelationshipBaseRow[]> {
	const placeholders = targetIds
		.map((_, index) => `?${index + 3}`)
		.join(', ');
	const { results } = await env.DB.prepare(
		`SELECT target.id AS target_id,
		        target.suspended_at AS target_suspended_at,
		        outgoing_follow.id AS outgoing_follow_id,
		        outgoing_follow.show_reblogs AS outgoing_show_reblogs,
		        outgoing_follow.notify AS outgoing_notify,
		        outgoing_follow.languages AS outgoing_languages,
		        incoming_follow.id AS incoming_follow_id,
		        outgoing_request.id AS outgoing_request_id,
		        incoming_request.id AS incoming_request_id,
		        outgoing_block.id AS outgoing_block_id,
		        incoming_block.id AS incoming_block_id,
		        outgoing_mute.id AS outgoing_mute_id,
		        outgoing_mute.hide_notifications AS outgoing_mute_notifications
		 FROM accounts target
		 LEFT JOIN follows outgoing_follow
		   ON outgoing_follow.account_id = ?1
		  AND outgoing_follow.target_account_id = target.id
		 LEFT JOIN follows incoming_follow
		   ON incoming_follow.account_id = target.id
		  AND incoming_follow.target_account_id = ?1
		 LEFT JOIN follow_requests outgoing_request
		   ON outgoing_request.account_id = ?1
		  AND outgoing_request.target_account_id = target.id
		 LEFT JOIN follow_requests incoming_request
		   ON incoming_request.account_id = target.id
		  AND incoming_request.target_account_id = ?1
		 LEFT JOIN blocks outgoing_block
		   ON outgoing_block.account_id = ?1
		  AND outgoing_block.target_account_id = target.id
		 LEFT JOIN blocks incoming_block
		   ON incoming_block.account_id = target.id
		  AND incoming_block.target_account_id = ?1
		 LEFT JOIN mutes outgoing_mute
		   ON outgoing_mute.account_id = ?1
		  AND outgoing_mute.target_account_id = target.id
		  AND (outgoing_mute.expires_at IS NULL OR outgoing_mute.expires_at > ?2)
		 WHERE target.id IN (${placeholders})`,
	).bind(accountId, now, ...targetIds).all<RelationshipBaseRow>();
	return results ?? [];
}

async function fetchRelationshipOptionalRows(
	accountId: string,
	targetIds: string[],
): Promise<RelationshipOptionalRow[]> {
	const placeholders = targetIds
		.map((_, index) => `?${index + 2}`)
		.join(', ');
	try {
		const { results } = await env.DB.prepare(
			`SELECT target.id AS target_id,
			        endorsement.id AS endorsement_id,
			        account_note.comment AS note_comment,
			        CASE WHEN target.domain IS NOT NULL AND EXISTS (
			          SELECT 1 FROM user_domain_blocks domain_block
			          WHERE domain_block.account_id = ?1
			            AND lower(domain_block.domain) = lower(target.domain)
			        ) THEN 1 ELSE 0 END AS domain_blocking
			 FROM accounts target
			 LEFT JOIN account_pins endorsement
			   ON endorsement.account_id = ?1
			  AND endorsement.target_account_id = target.id
			 LEFT JOIN account_notes account_note
			   ON account_note.account_id = ?1
			  AND account_note.target_account_id = target.id
			 WHERE target.id IN (${placeholders})`,
		).bind(accountId, ...targetIds).all<RelationshipOptionalRow>();
		return results ?? [];
	} catch {
		// Tables may not exist yet (pre-migration 0023).
		return [];
	}
}

async function fetchRelationshipStates(
	accountId: string,
	targetIds: string[],
	now: string,
): Promise<Map<string, RelationshipState>> {
	const states = new Map<string, RelationshipState>();
	const uniqueTargetIds = [...new Set(targetIds)];
	for (let offset = 0; offset < uniqueTargetIds.length; offset += RELATIONSHIP_QUERY_BATCH_SIZE) {
		const batchIds = uniqueTargetIds.slice(offset, offset + RELATIONSHIP_QUERY_BATCH_SIZE);
		const [baseRows, optionalRows] = await Promise.all([
			fetchRelationshipBaseRows(accountId, batchIds, now),
			fetchRelationshipOptionalRows(accountId, batchIds),
		]);
		const optionalByTarget = new Map(
			optionalRows.map((row) => [row.target_id, row] as const),
		);
		for (const row of baseRows) {
			const optional = optionalByTarget.get(row.target_id);
			states.set(row.target_id, {
				...row,
				endorsed: optional?.endorsement_id != null,
				note: optional?.note_comment ?? '',
				domainBlocking: optional?.domain_blocking === 1,
			});
		}
	}
	return states;
}

export async function getRelationship(accountId: string, targetId: string): Promise<Relationship> {
	const states = await fetchRelationshipStates(accountId, [targetId], new Date().toISOString());
	return buildRelationship(targetId, states.get(targetId) ?? null);
}

// ----------------------------------------------------------------
// Get batch relationships
// ----------------------------------------------------------------

export async function getRelationships(
	accountId: string,
	targetIds: string[],
	options?: { withSuspended?: boolean },
): Promise<Relationship[]> {
	if (targetIds.length === 0) return [];
	const states = await fetchRelationshipStates(
		accountId,
		targetIds,
		new Date().toISOString(),
	);
	return targetIds.flatMap((targetId) => {
		const state = states.get(targetId);
		const canView = canViewAccountRelationship({
			targetExists: state !== undefined,
			targetSuspended: state ? state.target_suspended_at !== null : null,
			includeSuspended: options?.withSuspended === true,
		});
		if (!canView || !state) {
			return [];
		}
		return [buildRelationship(targetId, state)];
	});
}

// ----------------------------------------------------------------
// Search accounts
// ----------------------------------------------------------------

export async function searchAccounts(
	query: string,
	limit: number = 40,
	offset: number = 0,
	options?: { followedBy?: string; viewerAccountId?: string },
): Promise<AccountRow[]> {
	const searchTerm = `%${query}%`;
	const discovery = buildAccountSearchSqlPredicate(
		'account',
		options?.viewerAccountId ?? null,
		new Date().toISOString(),
	);

	if (options?.followedBy) {
		const results = await env.DB
			.prepare(
				`SELECT a.* FROM accounts a
				JOIN follows f ON f.target_account_id = a.id
				WHERE f.account_id = ?
					AND (a.username LIKE ? OR a.display_name LIKE ?)
					AND ${discovery.sql}
				ORDER BY a.username ASC
				LIMIT ? OFFSET ?`,
			)
			.bind(
				options.followedBy,
				searchTerm,
				searchTerm,
				...discovery.bindings,
				limit,
				offset,
			)
			.all<AccountRow>();

		return results.results || [];
	}

	const results = await env.DB
		.prepare(
			`SELECT a.* FROM accounts a
			WHERE (a.username LIKE ? OR a.display_name LIKE ?)
			AND ${discovery.sql}
			ORDER BY
				CASE WHEN a.domain IS NULL THEN 0 ELSE 1 END,
				a.followers_count DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(searchTerm, searchTerm, ...discovery.bindings, limit, offset)
		.all<AccountRow>();

	return results.results || [];
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
	domain: string,
	accountId: string,
	target: { id: string; domain: string | null; locked: number; manually_approves_followers: number },
): Promise<CreateFollowResult> {
	if (accountId === target.id) {
		throw new AppError(422, 'Validation failed', 'You cannot follow yourself');
	}

	// Check existing follow
	const existingFollow = await env.DB
		.prepare('SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, target.id)
		.first();
	if (existingFollow) {
		return { type: 'follow', id: existingFollow.id as string, uri: '' };
	}

	// Check existing follow request
	const existingRequest = await env.DB
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

		await env.DB
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

	await env.DB.batch([
		env.DB
			.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)`,
			)
			.bind(id, accountId, target.id, followUri, now),
		env.DB.prepare('UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1').bind(accountId),
		env.DB.prepare('UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1').bind(target.id),
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
	accountId: string,
	targetId: string,
): Promise<RemoveFollowResult> {
	const follow = await env.DB
		.prepare('SELECT id, uri FROM follows WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	let deletedFollow: RemoveFollowResult['deletedFollow'] = null;

	if (follow) {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM follows WHERE id = ?1').bind(follow.id as string),
			env.DB.prepare('UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1').bind(accountId),
			env.DB.prepare('UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1').bind(targetId),
			env.DB.prepare(
				`DELETE FROM list_accounts
				 WHERE account_id = ?1
				   AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
			).bind(targetId, accountId),
		]);
		deletedFollow = { id: follow.id as string, uri: (follow.uri as string | null) };
	}

	// Also remove any pending follow request
	const fr = await env.DB
		.prepare('SELECT id, uri FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	let deletedFollowRequest: RemoveFollowResult['deletedFollowRequest'] = null;

	if (fr) {
		await env.DB.prepare('DELETE FROM follow_requests WHERE id = ?1').bind(fr.id as string).run();
		deletedFollowRequest = { id: fr.id as string, uri: (fr.uri as string | null) };
	}

	return { deletedFollow, deletedFollowRequest };
}

// ----------------------------------------------------------------
// Create block
// ----------------------------------------------------------------

export async function createBlock(
	accountId: string,
	targetId: string,
): Promise<void> {
	await assertAccountRelationshipMutable(accountId, targetId);

	const existing = await env.DB
		.prepare('SELECT id FROM blocks WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	const now = new Date().toISOString();
	const id = existing ? existing.id as string : generateUlid();

	// Blocking tears down both relationship directions and their derived counts.
	// Conditional count updates run before deletion so idempotent re-blocks do
	// not drift counters.
	await env.DB.batch([
		env.DB
			.prepare('INSERT OR IGNORE INTO blocks (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)')
			.bind(id, accountId, targetId, now),
		env.DB.prepare(
			`UPDATE accounts SET following_count = MAX(0, following_count - 1)
			 WHERE id = ?1 AND EXISTS (
			   SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2
			 )`,
		).bind(accountId, targetId),
		env.DB.prepare(
			`UPDATE accounts SET followers_count = MAX(0, followers_count - 1)
			 WHERE id = ?2 AND EXISTS (
			   SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2
			 )`,
		).bind(accountId, targetId),
		env.DB.prepare(
			`UPDATE accounts SET following_count = MAX(0, following_count - 1)
			 WHERE id = ?2 AND EXISTS (
			   SELECT 1 FROM follows WHERE account_id = ?2 AND target_account_id = ?1
			 )`,
		).bind(accountId, targetId),
		env.DB.prepare(
			`UPDATE accounts SET followers_count = MAX(0, followers_count - 1)
			 WHERE id = ?1 AND EXISTS (
			   SELECT 1 FROM follows WHERE account_id = ?2 AND target_account_id = ?1
			 )`,
		).bind(accountId, targetId),
		env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(accountId, targetId),
		env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, accountId),
		env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(accountId, targetId),
		env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, accountId),
		env.DB.prepare(
			`DELETE FROM list_accounts
			 WHERE account_id = ?1
			   AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
		).bind(targetId, accountId),
		env.DB.prepare(
			`DELETE FROM list_accounts
			 WHERE account_id = ?1
			   AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
		).bind(accountId, targetId),
		env.DB.prepare(
			`DELETE FROM account_pins
			 WHERE (account_id = ?1 AND target_account_id = ?2)
			    OR (account_id = ?2 AND target_account_id = ?1)`,
		).bind(accountId, targetId),
	]);
}

// ----------------------------------------------------------------
// Remove block
// ----------------------------------------------------------------

export async function removeBlock(accountId: string, targetId: string): Promise<void> {
	await env.DB
		.prepare('DELETE FROM blocks WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.run();
}

// ----------------------------------------------------------------
// Create mute
// ----------------------------------------------------------------

export async function createMute(
	accountId: string,
	targetId: string,
	notifications: boolean = true,
	expiresAt: string | null = null,
): Promise<void> {
	await assertAccountRelationshipMutable(accountId, targetId);

	const hideNotifications = notifications ? 1 : 0;
	const now = new Date().toISOString();

	const existing = await env.DB
		.prepare('SELECT id FROM mutes WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	if (existing) {
		await env.DB
			.prepare('UPDATE mutes SET hide_notifications = ?1, expires_at = ?2, updated_at = ?3 WHERE id = ?4')
			.bind(hideNotifications, expiresAt, now, existing.id as string)
			.run();
	} else {
		const id = generateUlid();
		await env.DB
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

export async function removeMute(accountId: string, targetId: string): Promise<void> {
	await env.DB
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
	followRequest: FollowRequestRow;
}

export async function acceptFollowRequest(
	domain: string,
	accountId: string,
	targetAccountId: string,
): Promise<AcceptFollowRequestResult> {
	const fr = await assertFollowRequestActionable(accountId, targetAccountId);

	const now = new Date().toISOString();
	const followId = generateUlid();

	// Look up the target account's username for the follow URI
	const targetAccount = await env.DB
		.prepare('SELECT username FROM accounts WHERE id = ?1')
		.bind(targetAccountId)
		.first<{ username: string }>();
	const targetUsername = targetAccount?.username ?? 'unknown';
	const followUri = `https://${domain}/users/${targetUsername}/followers/${followId}`;

	const actionable = buildActionableFollowRequestSqlPredicate();
	const results = await env.DB.batch([
		// Create the follow
		env.DB.prepare(
			`INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, languages, created_at, updated_at)
			 SELECT ?1, fr.account_id, fr.target_account_id, ?4, 1, 0, NULL, ?5, ?5
			 FROM follow_requests fr
			 JOIN accounts a ON a.id = fr.account_id
			 LEFT JOIN users requester_user ON requester_user.account_id = a.id
			 WHERE fr.account_id = ?2
			   AND fr.target_account_id = ?3
			   AND ${actionable.sql}
			   AND NOT EXISTS (
			     SELECT 1 FROM follows existing_follow
			     WHERE existing_follow.account_id = fr.account_id
			       AND existing_follow.target_account_id = fr.target_account_id
			   )`,
		).bind(followId, accountId, targetAccountId, followUri, now, ...actionable.bindings),
		// Update follower/following counts
		env.DB.prepare(
			`UPDATE accounts SET following_count = following_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(accountId, followId),
		env.DB.prepare(
			`UPDATE accounts SET followers_count = followers_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(targetAccountId, followId),
		// Remove the follow request
		env.DB.prepare(
			`DELETE FROM follow_requests
			 WHERE account_id = ?1 AND target_account_id = ?2
			   AND EXISTS (SELECT 1 FROM follows WHERE id = ?3)`,
		).bind(accountId, targetAccountId, followId),
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new AppError(403, 'This action is not allowed');
	}

	return { followId, followUri, followRequest: fr };
}

// ----------------------------------------------------------------
// Reject follow request
// ----------------------------------------------------------------

export interface RejectFollowRequestResult {
	/** The original follow_request row (including uri for federation) */
	followRequest: Record<string, unknown>;
}

export async function rejectFollowRequest(
	accountId: string,
	targetAccountId: string,
): Promise<RejectFollowRequestResult> {
	const fr = await env.DB
		.prepare('SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetAccountId)
		.first();

	if (!fr) {
		throw new AppError(404, 'Record not found');
	}

	await env.DB
		.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetAccountId)
		.run();

	return { followRequest: fr as Record<string, unknown> };
}

// ----------------------------------------------------------------
// Set personal note on account
// ----------------------------------------------------------------

export async function setAccountNote(
	accountId: string,
	targetId: string,
	comment: string,
): Promise<void> {
	const target = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
	if (!target) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	if (comment) {
		await env.DB
			.prepare(
				`INSERT INTO account_notes (id, account_id, target_account_id, comment, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				 ON CONFLICT(account_id, target_account_id) DO UPDATE SET comment = ?4, updated_at = ?6`,
			)
			.bind(generateUlid(), accountId, targetId, comment, now, now)
			.run();
	} else {
		await env.DB
			.prepare('DELETE FROM account_notes WHERE account_id = ?1 AND target_account_id = ?2')
			.bind(accountId, targetId)
			.run();
	}
}

// ----------------------------------------------------------------
// Pin (endorse) account
// ----------------------------------------------------------------

export async function pinAccount(
	accountId: string,
	targetId: string,
): Promise<void> {
	await assertAccountFeatureable(accountId, targetId);

	const existing = await env.DB
		.prepare('SELECT id FROM account_pins WHERE account_id = ?1 AND target_account_id = ?2')
		.bind(accountId, targetId)
		.first();

	if (!existing) {
		const now = new Date().toISOString();
		await env.DB
			.prepare('INSERT INTO account_pins (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)')
			.bind(generateUlid(), accountId, targetId, now)
			.run();
	}
}

// ----------------------------------------------------------------
// Remove follower
// ----------------------------------------------------------------

/**
 * Removes only a relationship owned by the target follower. Counters are
 * changed iff that exact relationship existed, keeping the idempotent API from
 * decrementing unrelated counts on repeated requests.
 */
export async function removeFollower(
	accountId: string,
	targetId: string,
): Promise<void> {
	const target = await env.DB.prepare(
		'SELECT id FROM accounts WHERE id = ?1 LIMIT 1',
	).bind(targetId).first<{ id: string }>();
	if (!target) throw new AppError(404, 'Record not found');

	const follow = await env.DB.prepare(
		`SELECT id FROM follows
		 WHERE account_id = ?1 AND target_account_id = ?2
		 LIMIT 1`,
	).bind(targetId, accountId).first<{ id: string }>();
	if (!follow) return;

	await env.DB.batch([
		env.DB.prepare('DELETE FROM follows WHERE id = ?1').bind(follow.id),
		env.DB.prepare(
			'UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1',
		).bind(accountId),
		env.DB.prepare(
			'UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1',
		).bind(targetId),
	]);
}

// ----------------------------------------------------------------
// Unpin (remove endorsement) account
// ----------------------------------------------------------------

export async function unpinAccount(
	accountId: string,
	targetId: string,
): Promise<void> {
	await env.DB
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
export async function getAliases(accountId: string): Promise<string[]> {
	const account = await env.DB.prepare(
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
export async function addAlias(accountId: string, actorUri: string): Promise<string[]> {
	const aliases = await getAliases(accountId);

	if (aliases.includes(actorUri)) return aliases;

	aliases.push(actorUri);

	const now = new Date().toISOString();
	await env.DB.prepare(
		'UPDATE accounts SET also_known_as = ?1, updated_at = ?2 WHERE id = ?3',
	).bind(JSON.stringify(aliases), now, accountId).run();

	return aliases;
}

/**
 * Remove an alias from an account's also_known_as list.
 * Returns the updated alias list.
 */
export async function removeAlias(accountId: string, alias: string): Promise<string[]> {
	const aliases = await getAliases(accountId);
	const filtered = aliases.filter((a) => a !== alias);

	const now = new Date().toISOString();
	await env.DB.prepare(
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
	accountId: string,
): Promise<{ username: string; uri: string } | null> {
	return env.DB.prepare(
		'SELECT username, uri FROM accounts WHERE id = ?1 LIMIT 1',
	).bind(accountId).first<{ username: string; uri: string }>();
}

/**
 * Set the moved_to_account_id on an account for migration.
 */
export async function setMovedTo(
	accountId: string,
	targetAccountId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
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
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await env.DB.prepare(
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
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await env.DB.prepare(
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
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await env.DB.prepare(
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
	accountId: string,
): Promise<Array<{ username: string; domain: string | null }>> {
	const { results } = await env.DB.prepare(
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
	accountId: string,
): Promise<string[]> {
	const { results } = await env.DB.prepare(
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
	accountId: string,
): Promise<Array<{ title: string; username: string; domain: string | null }>> {
	const { results } = await env.DB.prepare(
		`SELECT l.title, a.username, a.domain
		 FROM lists l
		 JOIN list_accounts la ON la.list_id = l.id
		 JOIN accounts a ON a.id = la.account_id
		 WHERE l.account_id = ?
		 ORDER BY l.title ASC`,
	).bind(accountId).all();
	return (results ?? []) as Array<{ title: string; username: string; domain: string | null }>;
}
