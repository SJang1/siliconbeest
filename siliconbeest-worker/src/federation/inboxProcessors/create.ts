/**
 * Inbox Processor: Create(Note)
 *
 * Handles incoming Create activities containing a Note object.
 * Inserts the remote status, resolves the author account, processes
 * mentions, and fans out to local followers' timelines.
 */

import type { Env } from '../../env';
import type { APActivity, APObject, APTag, APNote } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { resolveRemoteAccount } from '../resolveRemoteAccount';

/**
 * Determine visibility from the Note's to/cc fields.
 */
function resolveVisibility(note: APObject): string {
	const publicNs = 'https://www.w3.org/ns/activitystreams#Public';
	const toArr = Array.isArray(note.to) ? note.to : note.to ? [note.to] : [];
	const ccArr = Array.isArray(note.cc) ? note.cc : note.cc ? [note.cc] : [];

	if (toArr.includes(publicNs)) return 'public';
	if (ccArr.includes(publicNs)) return 'unlisted';
	// If addressed to followers collection but not public
	if (toArr.some((t) => t.endsWith('/followers'))) return 'private';
	console.warn(`[create] Could not determine visibility for note ${note.id}, defaulting to 'direct'`);
	return 'direct';
}

export async function processCreate(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const object = activity.object;
	if (!object || typeof object === 'string') {
		console.warn('[create] activity.object is missing or a bare URI');
		return;
	}

	const note = object as APObject;
	if (note.type !== 'Note') {
		console.log(`[create] Ignoring non-Note object type: ${note.type}`);
		return;
	}

	if (!note.id) {
		console.warn('[create] Note has no id');
		return;
	}

	// Check for duplicates
	const existingStatus = await env.DB.prepare(
		`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(note.id)
		.first();

	if (existingStatus) {
		return; // Already processed
	}

	// Resolve the remote author
	const authorAccountId = await resolveRemoteAccount(activity.actor, env);
	if (!authorAccountId) {
		console.error('[create] Could not resolve remote author');
		return;
	}

	const now = new Date().toISOString();
	const statusId = generateUlid();
	const visibility = resolveVisibility(note);

	// Resolve in_reply_to if present
	let inReplyToId: string | null = null;
	let inReplyToAccountId: string | null = null;
	let conversationId: string | null = null;
	if (note.inReplyTo) {
		const parentStatus = await env.DB.prepare(
			`SELECT id, account_id, conversation_id FROM statuses WHERE uri = ?1 LIMIT 1`,
		)
			.bind(note.inReplyTo)
			.first<{ id: string; account_id: string; conversation_id: string | null }>();

		if (parentStatus) {
			inReplyToId = parentStatus.id;
			inReplyToAccountId = parentStatus.account_id;
			conversationId = parentStatus.conversation_id;
		}
	}

	// Try to resolve conversation from AP conversation field
	const apNote = note as APNote;
	if (!conversationId && apNote.conversation) {
		const existingConv = await env.DB.prepare(
			'SELECT id FROM conversations WHERE ap_uri = ?1 LIMIT 1',
		).bind(apNote.conversation).first<{ id: string }>();
		if (existingConv) {
			conversationId = existingConv.id;
		} else {
			// Create new conversation with AP URI
			conversationId = generateUlid();
			await env.DB.prepare(
				'INSERT OR IGNORE INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
			).bind(conversationId, apNote.conversation, now).run();
			// Handle race: re-read in case another request inserted first
			const inserted = await env.DB.prepare(
				'SELECT id FROM conversations WHERE ap_uri = ?1 LIMIT 1',
			).bind(apNote.conversation).first<{ id: string }>();
			if (inserted) conversationId = inserted.id;
		}
	}

	// Fallback: create conversation without AP URI
	if (!conversationId) {
		conversationId = generateUlid();
		await env.DB.prepare(
			'INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
		).bind(conversationId, now).run();
	}

	// Resolve content: prefer standard content, fall back to Misskey _misskey_content
	const noteContent = note.content ?? (apNote._misskey_content ? apNote._misskey_content : '');

	// Resolve content warning: prefer standard summary, fall back to Misskey _misskey_summary
	const contentWarning = note.summary ?? (apNote._misskey_summary ? apNote._misskey_summary : '');

	// FEP-e232: Resolve quote post URI
	const quoteUri = apNote.quoteUri || apNote._misskey_quote || null;
	let quoteId: string | null = null;
	if (quoteUri) {
		const quotedStatus = await env.DB.prepare(
			`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
		)
			.bind(quoteUri)
			.first<{ id: string }>();
		if (quotedStatus) {
			quoteId = quotedStatus.id;
		}
	}

	// Insert the status
	await env.DB.prepare(
		`INSERT INTO statuses
		 (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id,
		  content, content_warning, visibility, sensitive, language,
		  conversation_id, local, reply, quote_id, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?14, ?15, ?16)`,
	)
		.bind(
			statusId,
			note.id,
			typeof note.url === 'string' ? note.url : note.id,
			authorAccountId,
			inReplyToId,
			inReplyToAccountId,
			noteContent,
			contentWarning,
			visibility,
			note.sensitive ? 1 : 0,
			'en',
			conversationId,
			inReplyToId ? 1 : 0,
			quoteId,
			note.published ?? now,
			now,
		)
		.run();

	// Update replies_count on parent if this is a reply
	if (inReplyToId) {
		await env.DB.prepare(
			`UPDATE statuses SET replies_count = replies_count + 1 WHERE id = ?1`,
		)
			.bind(inReplyToId)
			.run();
	}

	// Process mentions from tags
	const tags: APTag[] = note.tag ?? [];
	const mentionTags = tags.filter((t) => t.type === 'Mention');

	for (const mention of mentionTags) {
		if (!mention.href) continue;

		// Check if this mention refers to a local account
		const mentionedAccount = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri = ?1 AND domain IS NULL LIMIT 1`,
		)
			.bind(mention.href)
			.first<{ id: string }>();

		if (mentionedAccount) {
			// Insert mention record
			const mentionId = generateUlid();
			try {
				await env.DB.prepare(
					`INSERT INTO mentions (id, status_id, account_id, created_at)
					 VALUES (?1, ?2, ?3, ?4)`,
				)
					.bind(mentionId, statusId, mentionedAccount.id, now)
					.run();
			} catch {
				// duplicate mention, ignore
			}

			// Create notification for the mentioned user
			await env.QUEUE_INTERNAL.send({
				type: 'create_notification',
				recipientAccountId: mentionedAccount.id,
				senderAccountId: authorAccountId,
				notificationType: 'mention',
				statusId,
			});
		}
	}

	// Process hashtags from tags
	const hashtagTags = tags.filter((t) => t.type === 'Hashtag');
	for (const ht of hashtagTags) {
		const tagName = ((ht.name as string) || '').replace(/^#/, '').toLowerCase();
		if (!tagName) continue;
		try {
			const existing = await env.DB.prepare('SELECT id FROM tags WHERE name = ?1').bind(tagName).first<{ id: string }>();
			let tagId: string;
			if (existing) {
				tagId = existing.id;
				await env.DB.prepare('UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, tagId).run();
			} else {
				tagId = generateUlid();
				await env.DB.prepare(
					'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
				).bind(tagId, tagName, tagName, now).run();
			}
			await env.DB.prepare('INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES (?1, ?2)').bind(statusId, tagId).run();
		} catch {
			// ignore duplicates
		}
	}

	// Process custom emojis from tags — store remote emojis for rendering
	const emojiTags = tags.filter((t) => t.type === 'Emoji');
	for (const et of emojiTags) {
		const emojiName = ((et.name as string) || '').replace(/^:|:$/g, '');
		const iconObj = (et as any).icon as { url?: string } | undefined;
		const emojiUrl = iconObj?.url;
		if (!emojiName || !emojiUrl) continue;
		let emojiDomain: string | null = null;
		try { emojiDomain = new URL(emojiUrl).hostname; } catch { /* skip */ }
		if (!emojiDomain) continue;
		try {
			await env.DB.prepare(
				`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
				 ON CONFLICT(shortcode, domain) DO UPDATE SET image_key = excluded.image_key, updated_at = excluded.updated_at`,
			).bind(generateUlid(), emojiName, emojiDomain, emojiUrl, now).run();
		} catch {
			// ignore
		}
	}

	// Fan out to local followers' home timelines
	await env.QUEUE_INTERNAL.send({
		type: 'timeline_fanout',
		statusId,
		accountId: authorAccountId,
	});
}
