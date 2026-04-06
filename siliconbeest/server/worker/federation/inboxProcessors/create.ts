/**
 * Inbox Processor: Create(Note)
 *
 * Handles incoming Create activities containing a Note object.
 * Inserts the remote status, resolves the author account, processes
 * mentions, and fans out to local followers' timelines.
 */

import { env } from 'cloudflare:workers';
import type { APActivity, APObject, APTag, APNote } from '../../types/activitypub';
import type { StatusWithJoinedAccountRow } from '../../types/db';
import { generateUlid } from '../../utils/ulid';
import { sanitizeHtml } from '../../utils/sanitize';
import { BaseProcessor } from './BaseProcessor';

/**
 * Determine visibility from the Note's to/cc fields.
 */
function resolveVisibility(note: APObject): string {
	const publicNs = 'https://www.w3.org/ns/activitystreams#Public';
	const toArr = Array.isArray(note.to) ? note.to : note.to ? [note.to] : [];
	const ccArr = Array.isArray(note.cc) ? note.cc : note.cc ? [note.cc] : [];

	if (toArr.includes(publicNs)) return 'public';
	if (ccArr.includes(publicNs)) return 'unlisted';
	if (toArr.some((t) => t.endsWith('/followers'))) return 'private';
	console.warn(`[create] Could not determine visibility for note ${note.id}, defaulting to 'direct'`);
	return 'direct';
}

class CreateProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
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

		// Check for duplicates using repository
		const existing = await this.statusRepo.findByUri(note.id);
		if (existing) return;

		// Resolve the remote author
		const authorAccountId = await this.resolveActor(activity.actor);
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
				conversationId = generateUlid();
				await env.DB.prepare(
					'INSERT OR IGNORE INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
				).bind(conversationId, apNote.conversation, now).run();
				const inserted = await env.DB.prepare(
					'SELECT id FROM conversations WHERE ap_uri = ?1 LIMIT 1',
				).bind(apNote.conversation).first<{ id: string }>();
				if (inserted) conversationId = inserted.id;
			}
		}

		if (!conversationId) {
			conversationId = generateUlid();
			await env.DB.prepare(
				'INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
			).bind(conversationId, now).run();
		}

		// Resolve content
		const rawContent = note.content ?? (apNote._misskey_content ? apNote._misskey_content : '');
		const noteContent = sanitizeHtml(rawContent);
		const rawCw = note.summary ?? (apNote._misskey_summary ? apNote._misskey_summary : '');
		const contentWarning = sanitizeHtml(rawCw);

		// FEP-e232: Resolve quote post URI
		const quoteUri = apNote.quoteUri || apNote._misskey_quote || null;
		let quoteId: string | null = null;
		if (quoteUri) {
			const quotedStatus = await this.statusRepo.findByUri(quoteUri);
			if (quotedStatus) quoteId = quotedStatus.id;
		}

		// Extract emoji tags for db column
		const rawTags: APTag[] = Array.isArray(note.tag) ? note.tag : [];
		const emojiTagsForDb = rawTags
			.filter((t) => t.type === 'Emoji')
			.map((et) => {
				const name = (et.name || '').replace(/^:|:$/g, '');
				const iconObj = et.icon;
				return name && iconObj?.url ? { shortcode: name, url: iconObj.url, static_url: iconObj.url } : null;
			})
			.filter(Boolean);
		const emojiTagsJson = emojiTagsForDb.length > 0 ? JSON.stringify(emojiTagsForDb) : null;

		// Insert the status
		await env.DB.prepare(
			`INSERT INTO statuses
			 (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id,
			  content, content_warning, visibility, sensitive, language,
			  conversation_id, local, reply, quote_id, emoji_tags, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?14, ?15, ?16, ?17)`,
		)
			.bind(
				statusId, note.id,
				typeof note.url === 'string' ? note.url : note.id,
				authorAccountId, inReplyToId, inReplyToAccountId,
				noteContent, contentWarning, visibility,
				note.sensitive ? 1 : 0, 'en', conversationId,
				inReplyToId ? 1 : 0, quoteId, emojiTagsJson,
				note.published ? new Date(note.published).toISOString() : now, now,
			)
			.run();

		// Process media attachments
		await this.processAttachments(note, statusId, authorAccountId, now);

		// Update replies_count on parent
		if (inReplyToId) {
			await this.statusRepo.incrementCount(inReplyToId, 'replies_count');
		}

		// Process mentions, hashtags, emojis from tags
		const tags: APTag[] = note.tag ?? [];
		await this.processMentions(tags, statusId, authorAccountId, now);
		await this.processHashtags(tags, statusId, now);
		await this.processEmojis(tags, activity.actor, now);

		// Fan out to local followers' home timelines
		if (visibility !== 'direct') {
			await env.QUEUE_INTERNAL.send({
				type: 'timeline_fanout',
				statusId,
				accountId: authorAccountId,
			});
		} else {
			await this.fanoutDM(statusId, authorAccountId, now);
		}
	}

	private async processAttachments(
		note: APObject,
		statusId: string,
		authorAccountId: string,
		now: string,
	): Promise<void> {
		const rawAttachments = note.attachment;
		const attachments = Array.isArray(rawAttachments) ? rawAttachments : rawAttachments ? [rawAttachments] : [];
		for (const att of attachments) {
			if (!att || typeof att !== 'object') continue;
			const attObj = att as Record<string, unknown>;
			let url: string | null = null;
			if (typeof attObj.url === 'string') {
				url = attObj.url;
			} else if (Array.isArray(attObj.url)) {
				const link = (attObj.url as unknown[]).find((u) => typeof u === 'string' || (u && typeof u === 'object' && (u as Record<string, unknown>).href));
				url = typeof link === 'string' ? link : (link as Record<string, unknown> | undefined)?.href as string ?? null;
			} else if (attObj.url && typeof attObj.url === 'object' && (attObj.url as Record<string, unknown>).href) {
				url = (attObj.url as Record<string, unknown>).href as string;
			} else if (typeof attObj.href === 'string') {
				url = attObj.href;
			}
			if (!url) continue;

			const mediaType = (attObj.mediaType as string | undefined) || (attObj.mimeType as string | undefined) || 'image/jpeg';
			let type = 'unknown';
			if (mediaType.startsWith('image/')) type = 'image';
			else if (mediaType.startsWith('video/')) type = 'video';
			else if (mediaType.startsWith('audio/')) type = 'audio';
			else if (attObj.type === 'Image') type = 'image';
			else if (attObj.type === 'Video') type = 'video';
			else if (attObj.type === 'Audio') type = 'audio';
			else type = 'image';

			try {
				await env.DB.prepare(
					`INSERT OR IGNORE INTO media_attachments
					 (id, status_id, account_id, type, remote_url, file_key, file_content_type, description, width, height, blurhash, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
				).bind(
					generateUlid(), statusId, authorAccountId, type,
					url, url, mediaType,
					(attObj.name as string | undefined) || (attObj.summary as string | undefined) || null,
					(attObj.width as number | undefined) || null, (attObj.height as number | undefined) || null, (attObj.blurhash as string | undefined) || null, now,
				).run();
			} catch (e) {
				console.error(`Failed to insert media attachment for ${statusId}:`, e);
			}
		}
	}

	private async processMentions(
		tags: APTag[],
		statusId: string,
		authorAccountId: string,
		now: string,
	): Promise<void> {
		const mentionTags = tags.filter((t) => t.type === 'Mention');
		for (const mention of mentionTags) {
			if (!mention.href) continue;

			const mentionedAccount = await this.findLocalAccountByUri(mention.href);
			if (mentionedAccount) {
				try {
					await env.DB.prepare(
						`INSERT INTO mentions (id, status_id, account_id, created_at)
						 VALUES (?1, ?2, ?3, ?4)`,
					)
						.bind(generateUlid(), statusId, mentionedAccount.id, now)
						.run();
				} catch {
					// duplicate mention
				}

				await this.notify('mention', mentionedAccount.id, authorAccountId, statusId);
			}
		}
	}

	private async processHashtags(
		tags: APTag[],
		statusId: string,
		now: string,
	): Promise<void> {
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
	}

	private async processEmojis(
		tags: APTag[],
		actorUri: string,
		now: string,
	): Promise<void> {
		const actorServerDomain = new URL(actorUri).hostname;
		const emojiTags = tags.filter((t) => t.type === 'Emoji');
		const newEmojis: Array<{ shortcode: string; url: string; static_url: string; domain: string }> = [];

		for (const et of emojiTags) {
			const emojiName = ((et.name as string) || '').replace(/^:|:$/g, '');
			const emojiUrl = et.icon?.url;
			if (!emojiName || !emojiUrl) continue;
			const emojiDomain = actorServerDomain;
			if (!emojiDomain) continue;
			try {
				const result = await env.DB.prepare(
					`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
					 ON CONFLICT(shortcode, domain) DO UPDATE SET image_key = excluded.image_key, updated_at = excluded.updated_at`,
				).bind(generateUlid(), emojiName, emojiDomain, emojiUrl, now).run();
				if (result.meta.changes > 0) {
					newEmojis.push({ shortcode: emojiName, url: emojiUrl, static_url: emojiUrl, domain: emojiDomain });
				}
			} catch {
				// ignore
			}
		}

		// Notify streaming about new emojis
		if (newEmojis.length > 0) {
			try {
				const doId = (env as Record<string, any>).STREAMING_DO?.idFromName('__public__');
				const doStub = (env as Record<string, any>).STREAMING_DO?.get(doId);
				await doStub.fetch('https://streaming/event', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						event: 'emoji_update',
						payload: JSON.stringify(newEmojis),
						stream: ['public', 'public:local', 'user'],
					}),
				});
			} catch {
				// Streaming failure shouldn't block inbox processing
			}
		}
	}

	private async fanoutDM(
		statusId: string,
		authorAccountId: string,
		now: string,
	): Promise<void> {
		interface LocalMentionRow { account_id: string }
		const { results: localMentions } = await env.DB.prepare(
			`SELECT m.account_id FROM mentions m
			 JOIN accounts a ON a.id = m.account_id
			 WHERE m.status_id = ?1 AND a.domain IS NULL`,
		).bind(statusId).all<LocalMentionRow>();

		if (!localMentions || localMentions.length === 0) return;

		const stmts = localMentions.map((m) =>
			env.DB.prepare(
				'INSERT OR IGNORE INTO home_timeline_entries (status_id, account_id, created_at) VALUES (?1, ?2, ?3)',
			).bind(statusId, m.account_id, now),
		);
		await env.DB.batch(stmts);

		// Send streaming event for DM
		try {
			const dmStatusRow = await env.DB.prepare(
				`SELECT s.*, a.username AS a_username, a.domain AS a_domain, a.display_name AS a_display_name,
				        a.note AS a_note, a.uri AS a_uri, a.url AS a_url, a.avatar_url AS a_avatar_url,
				        a.avatar_static_url AS a_avatar_static_url, a.header_url AS a_header_url,
				        a.header_static_url AS a_header_static_url, a.locked AS a_locked, a.bot AS a_bot,
				        a.discoverable AS a_discoverable, a.followers_count AS a_followers_count,
				        a.following_count AS a_following_count, a.statuses_count AS a_statuses_count,
				        a.created_at AS a_created_at, a.emoji_tags AS a_emoji_tags
				 FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?1`,
			).bind(statusId).first<StatusWithJoinedAccountRow>();

			if (dmStatusRow) {
				const acct = dmStatusRow.a_domain
					? `${dmStatusRow.a_username}@${dmStatusRow.a_domain}`
					: dmStatusRow.a_username;
				const dmPayload = JSON.stringify({
					id: statusId, uri: dmStatusRow.uri, created_at: dmStatusRow.created_at,
					content: dmStatusRow.content, visibility: 'direct',
					sensitive: !!dmStatusRow.sensitive, spoiler_text: dmStatusRow.content_warning || '',
					language: dmStatusRow.language, url: dmStatusRow.url,
					in_reply_to_id: dmStatusRow.in_reply_to_id, in_reply_to_account_id: dmStatusRow.in_reply_to_account_id,
					reblogs_count: 0, favourites_count: 0, replies_count: 0, edited_at: null,
					media_attachments: [], mentions: [], tags: [], emojis: [],
					reblog: null, poll: null, card: null, application: null, text: null, filtered: [],
					account: {
						id: authorAccountId, username: dmStatusRow.a_username, acct,
						display_name: dmStatusRow.a_display_name || '',
						locked: !!dmStatusRow.a_locked, bot: !!dmStatusRow.a_bot,
						discoverable: !!dmStatusRow.a_discoverable, group: false,
						created_at: dmStatusRow.a_created_at, note: dmStatusRow.a_note || '',
						url: dmStatusRow.a_url || '', uri: dmStatusRow.a_uri || '',
						avatar: dmStatusRow.a_avatar_url || '', avatar_static: dmStatusRow.a_avatar_static_url || '',
						header: dmStatusRow.a_header_url || '', header_static: dmStatusRow.a_header_static_url || '',
						followers_count: dmStatusRow.a_followers_count || 0, following_count: dmStatusRow.a_following_count || 0,
						statuses_count: dmStatusRow.a_statuses_count || 0, last_status_at: null,
						emojis: [], fields: [],
					},
				});

				for (const m of localMentions) {
					const userRow = await env.DB.prepare('SELECT id FROM users WHERE account_id = ?1 LIMIT 1').bind(m.account_id).first<{ id: string }>();
					if (userRow) {
						try {
							const doId = (env as Record<string, any>).STREAMING_DO?.idFromName(userRow.id);
							const stub = (env as Record<string, any>).STREAMING_DO?.get(doId);
							await stub.fetch('https://streaming/event', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ event: 'update', payload: dmPayload, stream: ['user', 'direct'] }),
							});
						} catch { /* streaming failure shouldn't block */ }
					}
				}
			}
		} catch { /* streaming failure shouldn't block inbox processing */ }
	}
}

export async function processCreate(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new CreateProcessor().process(activity);
}
