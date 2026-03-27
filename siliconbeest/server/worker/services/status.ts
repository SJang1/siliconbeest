import { generateUlid } from '../utils/ulid';
import { parseContent } from '../utils/contentParser';
import type { StatusRow } from '../types/db';
import type { QueueMessage, TimelineFanoutMessage, DeliverActivityFanoutMessage } from '../types/queue';
import type { APActivity } from '../types/activitypub';

/**
 * Status service: CRUD for statuses, favourites, reblogs, bookmarks,
 * and thread context retrieval.
 */
export class StatusService {
	constructor(
		private db: D1Database,
		private domain: string,
		private federationQueue: Queue<QueueMessage>,
		private internalQueue: Queue<QueueMessage>,
	) {}

	// ----------------------------------------------------------------
	// Create status
	// ----------------------------------------------------------------
	async create(
		accountId: string,
		data: {
			text: string;
			visibility?: string;
			sensitive?: boolean;
			spoilerText?: string;
			inReplyToId?: string;
			mediaIds?: string[];
			language?: string;
			pollOptions?: string[];
			pollExpiresIn?: number;
			pollMultiple?: boolean;
		},
	): Promise<StatusRow> {
		const id = generateUlid();
		const now = new Date().toISOString();
		const visibility = data.visibility || 'public';
		const language = data.language || 'en';
		const sensitive = data.sensitive ? 1 : 0;
		const spoilerText = data.spoilerText || '';

		// Look up account for URI construction
		const account = await this.db.prepare('SELECT username FROM accounts WHERE id = ?').bind(accountId).first();
		if (!account) {
			throw new Error('Account not found');
		}
		const username = account.username as string;

		const uri = `https://${this.domain}/users/${username}/statuses/${id}`;
		const url = `https://${this.domain}/@${username}/${id}`;

		// Parse content into HTML with mentions, hashtags, URLs
		const parsed = parseContent(data.text, this.domain);

		// Resolve reply
		let inReplyToId: string | null = null;
		let inReplyToAccountId: string | null = null;
		let conversationId: string | null = null;
		let isReply = 0;

		if (data.inReplyToId) {
			const parent = (await this.db
				.prepare('SELECT id, account_id, conversation_id FROM statuses WHERE id = ? AND deleted_at IS NULL LIMIT 1')
				.bind(data.inReplyToId)
				.first()) as Pick<StatusRow, 'id' | 'account_id' | 'conversation_id'> | null;

			if (parent) {
				inReplyToId = parent.id;
				inReplyToAccountId = parent.account_id;
				conversationId = parent.conversation_id;
				isReply = 1;
			}
		}

		// Create conversation if needed
		if (!conversationId) {
			conversationId = generateUlid();
			await this.db
				.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)')
				.bind(conversationId, now, now)
				.run();
		}

		// Insert status
		await this.db
			.prepare(
				`INSERT INTO statuses
				(id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id,
				 reblog_of_id, text, content, content_warning, visibility, sensitive,
				 language, conversation_id, reply, replies_count, reblogs_count,
				 favourites_count, local, federated_at, edited_at, deleted_at,
				 poll_id, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, NULL, NULL, NULL, NULL, ?, ?)`,
			)
			.bind(
				id,
				uri,
				url,
				accountId,
				inReplyToId,
				inReplyToAccountId,
				data.text,
				parsed.html,
				spoilerText,
				visibility,
				sensitive,
				language,
				conversationId,
				isReply,
				now,
				now,
			)
			.run();

		// Update reply count on parent
		if (inReplyToId) {
			await this.db
				.prepare('UPDATE statuses SET replies_count = replies_count + 1, updated_at = ? WHERE id = ?')
				.bind(now, inReplyToId)
				.run();
		}

		// Attach media
		if (data.mediaIds && data.mediaIds.length > 0) {
			const mediaStmts = data.mediaIds.map((mediaId) =>
				this.db.prepare('UPDATE media_attachments SET status_id = ? WHERE id = ? AND account_id = ?').bind(id, mediaId, accountId),
			);
			await this.db.batch(mediaStmts);
		}

		// Create mention rows
		if (parsed.mentions.length > 0) {
			const mentionStmts: D1PreparedStatement[] = [];
			for (const mention of parsed.mentions) {
				// Look up mentioned account
				let mentionedAccount;
				if (mention.domain) {
					mentionedAccount = await this.db
						.prepare('SELECT id FROM accounts WHERE username = ? AND domain = ? LIMIT 1')
						.bind(mention.username.toLowerCase(), mention.domain.toLowerCase())
						.first();
				} else {
					mentionedAccount = await this.db
						.prepare('SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
						.bind(mention.username.toLowerCase())
						.first();
				}

				if (mentionedAccount) {
					const mentionId = generateUlid();
					mentionStmts.push(
						this.db
							.prepare('INSERT INTO mentions (id, status_id, account_id, silent, created_at) VALUES (?, ?, ?, 0, ?)')
							.bind(mentionId, id, mentionedAccount.id as string, now),
					);
				}
			}
			if (mentionStmts.length > 0) {
				await this.db.batch(mentionStmts);
			}
		}

		// Create/find tags and link to status
		if (parsed.tags.length > 0) {
			for (const tagName of parsed.tags) {
				let tag = await this.db.prepare('SELECT id FROM tags WHERE name = ? LIMIT 1').bind(tagName).first();
				if (!tag) {
					const tagId = generateUlid();
					await this.db
						.prepare(
							`INSERT INTO tags (id, name, display_name, usable, trendable, listable, last_status_at, created_at, updated_at)
							VALUES (?, ?, NULL, 1, 1, 1, ?, ?, ?)`,
						)
						.bind(tagId, tagName, now, now, now)
						.run();
					tag = { id: tagId };
				} else {
					await this.db.prepare('UPDATE tags SET last_status_at = ?, updated_at = ? WHERE id = ?').bind(now, now, tag.id as string).run();
				}

				await this.db.prepare('INSERT INTO status_tags (status_id, tag_id) VALUES (?, ?)').bind(id, tag.id as string).run();
			}
		}

		// Create poll if options provided
		if (data.pollOptions && data.pollOptions.length > 0) {
			const pollId = generateUlid();
			const expiresAt = data.pollExpiresIn ? new Date(Date.now() + data.pollExpiresIn * 1000).toISOString() : null;
			const multiple = data.pollMultiple ? 1 : 0;

			await this.db
				.prepare(
					`INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
					VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
				)
				.bind(pollId, id, expiresAt, multiple, JSON.stringify(data.pollOptions), now)
				.run();

			await this.db.prepare('UPDATE statuses SET poll_id = ? WHERE id = ?').bind(pollId, id).run();
		}

		// Update account status count
		await this.db
			.prepare('UPDATE accounts SET statuses_count = statuses_count + 1, last_status_at = ?, updated_at = ? WHERE id = ?')
			.bind(now, now, accountId)
			.run();

		// Enqueue timeline fanout
		await this.internalQueue.send({
			type: 'timeline_fanout',
			statusId: id,
			accountId,
		} satisfies TimelineFanoutMessage);

		// Enqueue federation delivery
		if (visibility !== 'direct') {
			const createActivity: APActivity = {
				type: 'Create',
				actor: `https://${this.domain}/users/${username}`,
				object: uri,
			};
			await this.federationQueue.send({
				type: 'deliver_activity_fanout',
				activity: createActivity,
				actorAccountId: accountId,
				statusId: id,
			} satisfies DeliverActivityFanoutMessage);
		}

		return (await this.getById(id))!;
	}

	// ----------------------------------------------------------------
	// Get by ID
	// ----------------------------------------------------------------
	async getById(id: string): Promise<StatusRow | null> {
		return (await this.db
			.prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL LIMIT 1')
			.bind(id)
			.first()) as StatusRow | null;
	}

	// ----------------------------------------------------------------
	// Delete (soft delete)
	// ----------------------------------------------------------------
	async delete(statusId: string, accountId: string): Promise<void> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}
		if (status.account_id !== accountId) {
			throw new Error('Not authorized to delete this status');
		}

		const now = new Date().toISOString();
		await this.db.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(now, now, statusId).run();

		// Decrement counts
		await this.db
			.prepare('UPDATE accounts SET statuses_count = MAX(statuses_count - 1, 0), updated_at = ? WHERE id = ?')
			.bind(now, accountId)
			.run();

		// Decrement reply count on parent
		if (status.in_reply_to_id) {
			await this.db
				.prepare('UPDATE statuses SET replies_count = MAX(replies_count - 1, 0), updated_at = ? WHERE id = ?')
				.bind(now, status.in_reply_to_id)
				.run();
		}

		// Enqueue Delete activity for federation
		const account = await this.db.prepare('SELECT username FROM accounts WHERE id = ?').bind(accountId).first();
		const deleteActivity: APActivity = {
			type: 'Delete',
			actor: `https://${this.domain}/users/${account!.username as string}`,
			object: status.uri,
		};
		await this.federationQueue.send({
			type: 'deliver_activity_fanout',
			activity: deleteActivity,
			actorAccountId: accountId,
			statusId,
		} satisfies DeliverActivityFanoutMessage);
	}

	// ----------------------------------------------------------------
	// Get thread context (ancestors + descendants)
	// ----------------------------------------------------------------
	async getContext(statusId: string): Promise<{ ancestors: StatusRow[]; descendants: StatusRow[] }> {
		// Ancestors: walk up the reply chain
		const ancestors: StatusRow[] = [];
		let currentId: string | null = statusId;

		while (currentId) {
			const status = (await this.db
				.prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL LIMIT 1')
				.bind(currentId)
				.first()) as StatusRow | null;

			if (!status || !status.in_reply_to_id) {
				break;
			}

			const parent = (await this.db
				.prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL LIMIT 1')
				.bind(status.in_reply_to_id)
				.first()) as StatusRow | null;

			if (parent) {
				ancestors.unshift(parent);
				currentId = parent.in_reply_to_id;
			} else {
				break;
			}
		}

		// Descendants: BFS through replies
		const descendants: StatusRow[] = [];
		const queue: string[] = [statusId];

		while (queue.length > 0) {
			const parentId = queue.shift()!;
			const replies = await this.db
				.prepare('SELECT * FROM statuses WHERE in_reply_to_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
				.bind(parentId)
				.all();

			for (const reply of (replies.results || []) as unknown as StatusRow[]) {
				descendants.push(reply);
				queue.push(reply.id);
			}
		}

		return { ancestors, descendants };
	}

	// ----------------------------------------------------------------
	// Favourite
	// ----------------------------------------------------------------
	async favourite(accountId: string, statusId: string): Promise<StatusRow> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}

		const existing = await this.db
			.prepare('SELECT id FROM favourites WHERE account_id = ? AND status_id = ? LIMIT 1')
			.bind(accountId, statusId)
			.first();

		if (!existing) {
			const id = generateUlid();
			const now = new Date().toISOString();
			await this.db
				.prepare('INSERT INTO favourites (id, account_id, status_id, uri, created_at) VALUES (?, ?, ?, NULL, ?)')
				.bind(id, accountId, statusId, now)
				.run();

			await this.db
				.prepare('UPDATE statuses SET favourites_count = favourites_count + 1, updated_at = ? WHERE id = ?')
				.bind(now, statusId)
				.run();
		}

		return (await this.getById(statusId))!;
	}

	// ----------------------------------------------------------------
	// Unfavourite
	// ----------------------------------------------------------------
	async unfavourite(accountId: string, statusId: string): Promise<StatusRow> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}

		const existing = await this.db
			.prepare('SELECT id FROM favourites WHERE account_id = ? AND status_id = ? LIMIT 1')
			.bind(accountId, statusId)
			.first();

		if (existing) {
			const now = new Date().toISOString();
			await this.db
				.prepare('DELETE FROM favourites WHERE account_id = ? AND status_id = ?')
				.bind(accountId, statusId)
				.run();

			await this.db
				.prepare('UPDATE statuses SET favourites_count = MAX(favourites_count - 1, 0), updated_at = ? WHERE id = ?')
				.bind(now, statusId)
				.run();
		}

		return (await this.getById(statusId))!;
	}

	// ----------------------------------------------------------------
	// Reblog
	// ----------------------------------------------------------------
	async reblog(accountId: string, statusId: string): Promise<StatusRow> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}

		if (status.visibility === 'direct' || status.visibility === 'private') {
			throw new Error('Cannot reblog a private or direct status');
		}

		// Check if already reblogged
		const existing = await this.db
			.prepare('SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ? AND deleted_at IS NULL LIMIT 1')
			.bind(accountId, statusId)
			.first();

		if (existing) {
			return (await this.getById(existing.id as string))!;
		}

		const id = generateUlid();
		const now = new Date().toISOString();

		const account = await this.db.prepare('SELECT username FROM accounts WHERE id = ?').bind(accountId).first();
		const username = account!.username as string;
		const uri = `https://${this.domain}/users/${username}/statuses/${id}/activity`;

		await this.db
			.prepare(
				`INSERT INTO statuses
				(id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id,
				 reblog_of_id, text, content, content_warning, visibility, sensitive,
				 language, conversation_id, reply, replies_count, reblogs_count,
				 favourites_count, local, federated_at, edited_at, deleted_at,
				 poll_id, created_at, updated_at)
				VALUES (?, ?, NULL, ?, NULL, NULL, ?, '', '', '', ?, 0, ?, NULL, 0, 0, 0, 0, 1, NULL, NULL, NULL, NULL, ?, ?)`,
			)
			.bind(id, uri, accountId, statusId, status.visibility, status.language, now, now)
			.run();

		await this.db
			.prepare('UPDATE statuses SET reblogs_count = reblogs_count + 1, updated_at = ? WHERE id = ?')
			.bind(now, statusId)
			.run();

		// Enqueue federation
		const announceActivity: APActivity = {
			type: 'Announce',
			actor: `https://${this.domain}/users/${username}`,
			object: status.uri,
		};
		await this.federationQueue.send({
			type: 'deliver_activity_fanout',
			activity: announceActivity,
			actorAccountId: accountId,
			statusId: id,
		} satisfies DeliverActivityFanoutMessage);

		return (await this.getById(id))!;
	}

	// ----------------------------------------------------------------
	// Unreblog
	// ----------------------------------------------------------------
	async unreblog(accountId: string, statusId: string): Promise<StatusRow> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}

		const reblog = (await this.db
			.prepare('SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ? AND deleted_at IS NULL LIMIT 1')
			.bind(accountId, statusId)
			.first()) as { id: string } | null;

		if (reblog) {
			const now = new Date().toISOString();
			await this.db.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(now, now, reblog.id).run();

			await this.db
				.prepare('UPDATE statuses SET reblogs_count = MAX(reblogs_count - 1, 0), updated_at = ? WHERE id = ?')
				.bind(now, statusId)
				.run();

			// Enqueue Undo Announce
			const undoAccount = await this.db.prepare('SELECT username FROM accounts WHERE id = ?').bind(accountId).first();
			const undoActivity: APActivity = {
				type: 'Undo',
				actor: `https://${this.domain}/users/${undoAccount!.username as string}`,
				object: status.uri,
			};
			await this.federationQueue.send({
				type: 'deliver_activity_fanout',
				activity: undoActivity,
				actorAccountId: accountId,
				statusId: reblog.id,
			} satisfies DeliverActivityFanoutMessage);
		}

		return (await this.getById(statusId))!;
	}

	// ----------------------------------------------------------------
	// Bookmark
	// ----------------------------------------------------------------
	async bookmark(accountId: string, statusId: string): Promise<void> {
		const status = await this.getById(statusId);
		if (!status) {
			throw new Error('Status not found');
		}

		const existing = await this.db
			.prepare('SELECT id FROM bookmarks WHERE account_id = ? AND status_id = ? LIMIT 1')
			.bind(accountId, statusId)
			.first();

		if (!existing) {
			const id = generateUlid();
			const now = new Date().toISOString();
			await this.db
				.prepare('INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?, ?, ?, ?)')
				.bind(id, accountId, statusId, now)
				.run();
		}
	}

	// ----------------------------------------------------------------
	// Unbookmark
	// ----------------------------------------------------------------
	async unbookmark(accountId: string, statusId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM bookmarks WHERE account_id = ? AND status_id = ?')
			.bind(accountId, statusId)
			.run();
	}
}
