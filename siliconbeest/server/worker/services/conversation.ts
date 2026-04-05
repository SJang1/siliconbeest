/**
 * Conversation Service
 *
 * Pure DB operations for conversation (direct message) endpoints.
 */

import { AppError } from '../middleware/errorHandler';

// ----------------------------------------------------------------
// List conversations
// ----------------------------------------------------------------

export interface ConversationListOpts {
	paginationQuery: PaginationQuery;
	whereClause: string;
	orderClause: string;
	limitValue: number;
	params: (string | number)[];
}

/**
 * Get conversation entries for a user with pagination.
 * Returns raw conversation rows (conversation_id, last_status_id, unread).
 */
export async function listConversationEntries(
	db: D1Database,
	accountId: string,
	opts: ConversationListOpts,
): Promise<Record<string, unknown>[]> {
	const conditions: string[] = ['ca.account_id = ?'];
	const binds: (string | number)[] = [accountId];

	if (opts.whereClause) {
		conditions.push(opts.whereClause);
		binds.push(...opts.params);
	}

	const sql = `
		SELECT ca.conversation_id, ca.last_status_id, ca.unread,
		       conv.created_at AS conv_created_at, conv.updated_at AS conv_updated_at
		FROM conversation_accounts ca
		JOIN conversations conv ON conv.id = ca.conversation_id
		WHERE ${conditions.join(' AND ')}
		ORDER BY ${opts.orderClause}
		LIMIT ?
	`;
	binds.push(opts.limitValue);

	const { results } = await db.prepare(sql).bind(...binds).all();
	return (results ?? []) as Record<string, unknown>[];
}

/**
 * Get participants in a conversation excluding the current user.
 */
export async function getConversationParticipants(
	db: D1Database,
	conversationId: string,
	excludeAccountId: string,
): Promise<Record<string, unknown>[]> {
	const { results } = await db.prepare(
		`SELECT a.*
		 FROM conversation_accounts ca2
		 JOIN accounts a ON a.id = ca2.account_id
		 WHERE ca2.conversation_id = ?1 AND ca2.account_id != ?2`,
	).bind(conversationId, excludeAccountId).all();

	return (results ?? []) as Record<string, unknown>[];
}

/**
 * Get the last status in a conversation with account data.
 */
export async function getConversationLastStatus(
	db: D1Database,
	statusId: string,
): Promise<Record<string, unknown> | null> {
	return db.prepare(
		`SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
		        a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
		        a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
		        a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
		        a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
		        a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
		        a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
		        a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
		        a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
		        a.emoji_tags AS a_emoji_tags
		 FROM statuses s
		 JOIN accounts a ON a.id = s.account_id
		 WHERE s.id = ?1 AND s.deleted_at IS NULL`,
	).bind(statusId).first();
}

// ----------------------------------------------------------------
// Mark conversation as read
// ----------------------------------------------------------------

/**
 * Mark a conversation as read for a user.
 * Throws 404 if the user is not a participant.
 */
export async function markConversationRead(
	db: D1Database,
	conversationId: string,
	accountId: string,
): Promise<void> {
	const entry = await db.prepare(
		'SELECT conversation_id FROM conversation_accounts WHERE conversation_id = ?1 AND account_id = ?2',
	).bind(conversationId, accountId).first();

	if (!entry) throw new AppError(404, 'Record not found');

	await db.prepare(
		'UPDATE conversation_accounts SET unread = 0 WHERE conversation_id = ?1 AND account_id = ?2',
	).bind(conversationId, accountId).run();
}

// ----------------------------------------------------------------
// Delete (hide) conversation
// ----------------------------------------------------------------

/**
 * Remove a user's participation in a conversation (hides it).
 * Throws 404 if the user is not a participant.
 */
export async function deleteConversation(
	db: D1Database,
	conversationId: string,
	accountId: string,
): Promise<void> {
	const entry = await db.prepare(
		'SELECT conversation_id FROM conversation_accounts WHERE conversation_id = ?1 AND account_id = ?2',
	).bind(conversationId, accountId).first();

	if (!entry) throw new AppError(404, 'Record not found');

	await db.prepare(
		'DELETE FROM conversation_accounts WHERE conversation_id = ?1 AND account_id = ?2',
	).bind(conversationId, accountId).run();
}
