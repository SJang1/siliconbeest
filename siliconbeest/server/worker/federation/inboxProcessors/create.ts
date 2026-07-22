/**
 * Inbox Processor: Create(Article | Note | Question)
 *
 * Handles incoming Create activities containing an Article, Note, or Question object.
 * Inserts the remote status, resolves the author account, processes
 * mentions, and fans out to local followers' timelines.
 * For Question objects (polls), also extracts poll options and metadata.
 */

import { env } from 'cloudflare:workers';
import type { APActivity, APObject, APTag, APNote, APQuestion, APQuestionOption } from '../../types/activitypub';
import type { StatusWithJoinedAccountRow } from '../../types/db';
import { generateUlid } from '../../utils/ulid';
import { sanitizeArticleHtml, sanitizeHtml, sanitizePlainText } from '../../utils/sanitize';
import { BaseProcessor } from './BaseProcessor';
import { getQuoteUri, verifyQuoteAuthorization } from '../helpers/quote';
import { customEmojiTagDomain, emojiTagToCustomEmoji } from '../../../../../packages/shared/utils/customEmoji';
import { parseQuotePolicyDetailsFromInteractionPolicy } from '../../../../../packages/shared/utils/quotePolicy';
import { constrainQuoteVisibility } from '../../../../../packages/shared/permissions';
import { sendStreamEvent } from '../../services/streaming';
import {
	canAccountInteractWithStatus,
	canAccountOriginateFederationActivity,
	canProcessFederatedStatusInteraction,
	canSurfaceStatusToViewer,
} from '../../services/permissions';
import { serializeNaturalLanguageMap } from '../../../../../packages/shared/utils/naturalLanguage';
import { normalizeFederatedTime } from '../../../../../packages/shared/utils/federatedTime';
import { recordRemoteObjectEvent } from '../../services/remoteObjectJournal';

interface CreateProcessorOptions {
	fanout?: boolean;
	notify?: boolean;
}

type StoredPollOption = { title: string; votes_count: number };

function isStoredPollOption(value: unknown): value is StoredPollOption {
	if (!value || typeof value !== 'object') return false;
	const option = value as Record<string, unknown>;
	return typeof option.title === 'string' && typeof option.votes_count === 'number';
}

/**
 * Determine visibility from the Note's to/cc fields.
 */
function resolveVisibility(note: APObject): string {
	const toArr = idsFrom(note.to);
	const ccArr = idsFrom(note.cc);

	if (toArr.some(isPublicCollection)) return 'public';
	if (ccArr.some(isPublicCollection)) return 'unlisted';
	if (toArr.some((t) => t.endsWith('/followers'))) return 'private';
	console.warn(`[create] Could not determine visibility for note ${note.id}, defaulting to 'direct'`);
	return 'direct';
}

function idsFrom(value: unknown): string[] {
	if (!value) return [];
	if (typeof value === 'string') return [value];
	if (value instanceof URL) return [value.href];
	if (Array.isArray(value)) return value.flatMap(idsFrom);
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return idsFrom(obj.id).concat(idsFrom(obj['@id'])).concat(idsFrom(obj.href));
	}
	return [];
}

function isPublicCollection(value: string): boolean {
	return value === 'https://www.w3.org/ns/activitystreams#Public'
		|| value === 'as:Public'
		|| value === 'Public';
}

function firstString(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstString(item);
			if (found) return found;
		}
		return '';
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value as Record<string, unknown>)) {
			const found = firstString(item);
			if (found) return found;
		}
	}
	return '';
}

function firstLanguage(map: unknown): string | null {
	if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
	const [language] = Object.keys(map as Record<string, unknown>);
	return language || null;
}

function firstUrl(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value instanceof URL) return value.href;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstUrl(item);
			if (found) return found;
		}
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return firstUrl(obj.href) ?? firstUrl(obj.id) ?? firstUrl(obj.url);
	}
	return null;
}

class CreateProcessor extends BaseProcessor {
	async process(activity: APActivity, options: CreateProcessorOptions = {}): Promise<boolean> {
		const object = activity.object;
		if (!object || typeof object === 'string') {
			console.warn('[create] activity.object is missing or a bare URI');
			return false;
		}

		const note = object as APObject;
		if (note.type !== 'Article' && note.type !== 'Note' && note.type !== 'Question') {
			console.log(`[create] Ignoring unsupported status object type: ${note.type}`);
			return false;
		}

		if (!note.id) {
			console.warn('[create] Note has no id');
			return false;
		}
		const objectDecision = await recordRemoteObjectEvent({
			objectUri: note.id,
			kind: 'Create',
			activityId: activity.id ?? null,
			actorUri: activity.actor,
			sourceTimestamp: note.published,
		});
		if (!objectDecision.apply || objectDecision.tombstoned) return false;

		// Check for duplicates using repository
		const existing = await this.statusRepo.findByUri(note.id);
		if (existing) return false;

		// Resolve the remote author
		const authorAccountId = await this.resolveActor(activity.actor);
		if (!authorAccountId) {
			console.error('[create] Could not resolve remote author');
			return false;
		}
		if (!await canAccountOriginateFederationActivity(authorAccountId)) return false;

		// Detect poll vote: Note with `name` (option text), inReplyTo, and no content
		if (note.type === 'Note' && note.name && note.inReplyTo && !note.content) {
			return this.processVote(note, authorAccountId);
		}

		const now = new Date().toISOString();
		const receivedAtMs = Date.now();
		const federatedTime = normalizeFederatedTime(note.published, receivedAtMs);
		const statusId = generateUlid();
		let visibility = resolveVisibility(note);

		// Resolve in_reply_to if present
		let inReplyToId: string | null = null;
		let inReplyToAccountId: string | null = null;
		let conversationId: string | null = null;
		if (note.inReplyTo) {
			const parentStatus = await env.DB_META_C000.prepare(
				`SELECT id, account_id, conversation_id FROM statuses WHERE uri = ?1 LIMIT 1`,
			)
				.bind(note.inReplyTo)
				.first<{ id: string; account_id: string; conversation_id: string | null }>();

			if (parentStatus) {
				if (!await canAccountInteractWithStatus(parentStatus.id, authorAccountId)) {
					return false;
				}
				inReplyToId = parentStatus.id;
				inReplyToAccountId = parentStatus.account_id;
				conversationId = parentStatus.conversation_id;
			}
		}

		// Try to resolve conversation from AP conversation field
		const apNote = note as APNote;
		if (!conversationId && apNote.conversation) {
			const existingConv = await env.DB_META_C000.prepare(
				'SELECT id FROM conversations WHERE ap_uri = ?1 LIMIT 1',
			).bind(apNote.conversation).first<{ id: string }>();
			if (existingConv) {
				conversationId = existingConv.id;
			} else {
				conversationId = generateUlid();
				await env.DB_META_C000.prepare(
					'INSERT OR IGNORE INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
				).bind(conversationId, apNote.conversation, now).run();
				const inserted = await env.DB_META_C000.prepare(
					'SELECT id FROM conversations WHERE ap_uri = ?1 LIMIT 1',
				).bind(apNote.conversation).first<{ id: string }>();
				if (inserted) conversationId = inserted.id;
			}
		}

		if (!conversationId) {
			conversationId = generateUlid();
			await env.DB_META_C000.prepare(
				'INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
			).bind(conversationId, now).run();
		}

		// Resolve content
		const rawContent = firstString(note.content)
			|| firstString((apNote as Record<string, unknown>).contentMap)
			|| firstString(apNote._misskey_content);
		const objectType = note.type === 'Article' ? 'Article' : 'Note';
		const noteContent = objectType === 'Article'
			? sanitizeArticleHtml(rawContent)
			: sanitizeHtml(rawContent);
		const sourceText = note.source && typeof note.source === 'object'
			? firstString((note.source as Record<string, unknown>).content)
			: '';
		const rawCw = firstString(note.summary)
			|| firstString((apNote as Record<string, unknown>).summaryMap)
			|| firstString(apNote._misskey_summary);
		const contentWarning = sanitizeHtml(rawCw);
		const title = objectType === 'Article'
			? sanitizePlainText(firstString(note.name) || firstString(note.nameMap))
			: '';
		const language = firstLanguage((apNote as Record<string, unknown>).contentMap) ?? 'en';
		const titleMap = objectType === 'Article'
			? serializeNaturalLanguageMap(note.nameMap, sanitizePlainText)
			: null;
		const contentMap = serializeNaturalLanguageMap(
			(apNote as Record<string, unknown>).contentMap,
			objectType === 'Article' ? sanitizeArticleHtml : sanitizeHtml,
		);
		const contentWarningMap = serializeNaturalLanguageMap(
			(apNote as Record<string, unknown>).summaryMap,
			sanitizeHtml,
		);
		const statusUrl = firstUrl(note.url) ?? note.id;

		// FEP-044f + fallback implementations: Resolve quote post URI
		const quoteUri = getQuoteUri(apNote) || apNote.quoteUri || apNote._misskey_quote || null;
		let quoteId: string | null = null;
		let quoteAuthorizationUri: string | null = null;
		let quoteApprovalStatus = 'none';
		if (quoteUri) {
			const quotedStatus = await this.statusRepo.findByUri(quoteUri);
			if (quotedStatus) {
				const targetAuthor = await env.DB_META_C000.prepare(
					'SELECT uri FROM accounts WHERE id = ?1 LIMIT 1',
				).bind(quotedStatus.account_id).first<{ uri: string }>();
				const selfQuote = targetAuthor?.uri === activity.actor;
				const candidateAuthorization = typeof apNote.quoteAuthorization === 'string'
					? apNote.quoteAuthorization
					: null;
				const authorized = selfQuote || await verifyQuoteAuthorization({
					authorizationUri: candidateAuthorization,
					interactingObjectUri: note.id,
					interactionTargetUri: quoteUri,
					targetAttributedTo: targetAuthor?.uri ?? '',
				});
				const constrainedVisibility = constrainQuoteVisibility(
					visibility,
					quotedStatus.visibility,
				);
				if (authorized && constrainedVisibility) {
					visibility = constrainedVisibility;
					quoteId = quotedStatus.id;
					quoteAuthorizationUri = candidateAuthorization;
					quoteApprovalStatus = 'accepted';
				} else {
					quoteApprovalStatus = !constrainedVisibility
						? 'invalid_visibility'
						: candidateAuthorization ? 'invalid' : 'missing';
				}
			}
		}

		// Extract emoji tags for db column
		const rawTags: APTag[] = Array.isArray(note.tag) ? note.tag : note.tag ? [note.tag as APTag] : [];
		const emojiTagsForDb = rawTags
			.filter((t) => t.type === 'Emoji')
			.map((et) => {
				const emoji = emojiTagToCustomEmoji(et as unknown as Record<string, unknown>);
				return emoji ? { shortcode: emoji.shortcode, url: emoji.url, static_url: emoji.static_url } : null;
			})
			.filter(Boolean);
			const emojiTagsJson = emojiTagsForDb.length > 0 ? JSON.stringify(emojiTagsForDb) : null;
			const interactionPolicy = (apNote as Record<string, unknown>).interactionPolicy;
			const quotePolicyDetails = parseQuotePolicyDetailsFromInteractionPolicy(
				interactionPolicy,
				activity.actor,
				`${activity.actor}/followers`,
			);
			const quotePolicy = quotePolicyDetails.policy;
			const automaticApprovalsJson = interactionPolicy !== undefined
				? JSON.stringify(quotePolicyDetails.automaticApprovals)
				: null;
			const manualApprovalsJson = interactionPolicy !== undefined
				? JSON.stringify(quotePolicyDetails.manualApprovals)
				: null;

			// Insert the status
			await env.DB_META_C000.prepare(
				`INSERT INTO statuses
				 (id, uri, url, object_type, title, account_id, in_reply_to_id, in_reply_to_account_id,
				  text, content, content_warning, visibility, sensitive, language,
				  conversation_id, local, reply, quote_id, quote_authorization_uri, quote_approval_status,
				  quote_policy, quote_policy_automatic_approvals, quote_policy_manual_approvals,
				  title_map, content_map, content_warning_map,
				  emoji_tags, created_at, updated_at,
				  published_at_raw, published_at_ms, received_at_ms, sort_at_ms, source_version)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)`,
			)
			.bind(
				statusId, note.id,
				statusUrl,
				objectType, title, authorAccountId, inReplyToId, inReplyToAccountId,
				sourceText, noteContent, contentWarning, visibility,
				note.sensitive ? 1 : 0, language, conversationId,
				inReplyToId ? 1 : 0, quoteId, quoteAuthorizationUri, quoteApprovalStatus,
				quotePolicy, automaticApprovalsJson, manualApprovalsJson,
				titleMap, contentMap, contentWarningMap, emojiTagsJson,
				federatedTime.publishedAtMs === null
					? now
					: new Date(federatedTime.publishedAtMs).toISOString(),
				now,
				federatedTime.publishedAtRaw,
				federatedTime.publishedAtMs,
				federatedTime.receivedAtMs,
				federatedTime.sortAtMs,
				objectDecision.sourceVersion,
			)
				.run();

		// Process poll data if this is a Question
		if (note.type === 'Question') {
			await this.processQuestionData(note as APQuestion, statusId, now);
		}

		// Process media attachments
		await this.processAttachments(note, statusId, authorAccountId, now);

		// Update replies_count on parent
		if (inReplyToId) {
			await this.statusRepo.incrementCount(inReplyToId, 'replies_count');
		}

		// Process mentions, hashtags, emojis from tags
		const tags: APTag[] = Array.isArray(note.tag) ? note.tag : note.tag ? [note.tag as APTag] : [];
		await this.processMentions(tags, statusId, authorAccountId, now, options.notify !== false);
		await this.processHashtags(tags, statusId, now);
		await this.processEmojis(tags, activity.actor, now);

		// Stream to local followers and public feeds
		if (options.fanout !== false) {
			if (visibility !== 'direct') {
				await env.QUEUE_INTERNAL.send({
					type: 'timeline_fanout',
					statusId,
					accountId: authorAccountId,
				});
			} else {
				await this.fanoutDM(statusId, authorAccountId);
			}
		}
		return true;
	}

	private async processQuestionData(
		question: APQuestion,
		statusId: string,
		now: string,
	): Promise<void> {
		const optionsRaw = question.oneOf ?? question.anyOf;
		if (!optionsRaw || optionsRaw.length === 0) return;

		const multiple = question.anyOf ? 1 : 0;
		const options = optionsRaw
			.filter((o: APQuestionOption) => o.name)
			.map((o: APQuestionOption) => ({
				title: o.name,
				votes_count: o.replies?.totalItems ?? 0,
			}));

		if (options.length === 0) return;

		const votesCount = options.reduce((sum: number, o: { votes_count: number }) => sum + o.votes_count, 0);
		const votersCount = question.votersCount ?? 0;
		const expiresAt = question.endTime ? new Date(question.endTime).toISOString() : null;
		const pollId = generateUlid();

		try {
			await env.DB_META_C000.batch([
				env.DB_META_C000.prepare(
					`INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
				).bind(pollId, statusId, expiresAt, multiple, votesCount, votersCount, JSON.stringify(options), now),
				env.DB_META_C000.prepare(
					'UPDATE statuses SET poll_id = ?1 WHERE id = ?2',
				).bind(pollId, statusId),
			]);
		} catch (e) {
			console.error(`[create] Failed to insert poll for status ${statusId}:`, e);
		}
	}

	private async processVote(
		note: APObject,
		voterAccountId: string,
	): Promise<boolean> {
		const optionName = note.name as string;
		const questionUri = note.inReplyTo as string;

		// Find the local status this vote is for
		const parentStatus = await env.DB_META_C000.prepare(
			'SELECT id, poll_id FROM statuses WHERE uri = ?1 LIMIT 1',
		).bind(questionUri).first<{ id: string; poll_id: string | null }>();

		if (!parentStatus?.poll_id) return false;
		if (!await canProcessFederatedStatusInteraction(
			parentStatus.id,
			voterAccountId,
			this.recipientAccountId || null,
		)) return false;

		// Find the poll
		const poll = await env.DB_META_C000.prepare(
			'SELECT id, options, expires_at, multiple FROM polls WHERE id = ?1 LIMIT 1',
		).bind(parentStatus.poll_id).first<{
			id: string;
			options: string;
			expires_at: string | null;
			multiple: number;
		}>();
		if (!poll) return false;
		if (poll.expires_at) {
			const expiresAt = Date.parse(poll.expires_at);
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
		}

		let options: StoredPollOption[];
		try {
			const parsed: unknown = JSON.parse(poll.options);
			if (!Array.isArray(parsed) || !parsed.every(isStoredPollOption)) return false;
			options = parsed;
		} catch {
			return false;
		}
		const choiceIndex = options.findIndex((o) => o.title === optionName);
		if (choiceIndex === -1) return false;
		if (poll.multiple === 0) {
			const existingVote = await env.DB_META_C000.prepare(
				'SELECT 1 FROM poll_votes WHERE poll_id = ?1 AND account_id = ?2 LIMIT 1',
			).bind(poll.id, voterAccountId).first();
			if (existingVote) return false;
		}

		const now = new Date().toISOString();

		try {
			// Insert vote (UNIQUE constraint prevents duplicates)
			await env.DB_META_C000.prepare(
				'INSERT INTO poll_votes (id, poll_id, account_id, choice, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
			).bind(generateUlid(), poll.id, voterAccountId, choiceIndex, now).run();

			// Update poll counts
			options[choiceIndex].votes_count += 1;
			const newVotesCount = options.reduce((sum, o) => sum + o.votes_count, 0);

			// Count distinct voters
			const voterCount = await env.DB_META_C000.prepare(
				'SELECT COUNT(DISTINCT account_id) AS cnt FROM poll_votes WHERE poll_id = ?1',
			).bind(poll.id).first<{ cnt: number }>();

			await env.DB_META_C000.prepare(
				'UPDATE polls SET options = ?1, votes_count = ?2, voters_count = ?3 WHERE id = ?4',
			).bind(JSON.stringify(options), newVotesCount, voterCount?.cnt ?? 0, poll.id).run();
			return true;
		} catch {
			// UNIQUE constraint violation = duplicate vote, ignore
			return false;
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
				const link = (attObj.url as (string | Record<string, unknown>)[]).find((u) => typeof u === 'string' || (u && typeof u === 'object' && (u as Record<string, unknown>).href));
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
				await env.DB_META_C000.prepare(
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
		notify = true,
	): Promise<void> {
		const mentionTags = tags.filter((t) => t.type === 'Mention');
		for (const mention of mentionTags) {
			if (!mention.href) continue;

			const mentionedAccount = await this.findLocalAccountByUri(mention.href);
			if (mentionedAccount) {
				try {
					await env.DB_META_C000.prepare(
						`INSERT INTO mentions (id, status_id, account_id, created_at)
						 VALUES (?1, ?2, ?3, ?4)`,
					)
						.bind(generateUlid(), statusId, mentionedAccount.id, now)
						.run();
				} catch {
					// duplicate mention
				}

				if (notify) {
					await this.notify('mention', mentionedAccount.id, authorAccountId, statusId);
				}
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
				const existing = await env.DB_META_C000.prepare('SELECT id FROM tags WHERE name = ?1').bind(tagName).first<{ id: string }>();
				let tagId: string;
				if (existing) {
					tagId = existing.id;
					await env.DB_META_C000.prepare('UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, tagId).run();
				} else {
					tagId = generateUlid();
					await env.DB_META_C000.prepare(
						'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
					).bind(tagId, tagName, tagName, now).run();
				}
				await env.DB_META_C000.prepare('INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES (?1, ?2)').bind(statusId, tagId).run();
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
		const emojiTags = tags.filter((t) => t.type === 'Emoji');
		const newEmojis: Array<{ shortcode: string; url: string; static_url: string; domain: string }> = [];

		for (const et of emojiTags) {
			const emoji = emojiTagToCustomEmoji(et as unknown as Record<string, unknown>);
			if (!emoji) continue;
			const emojiDomain = customEmojiTagDomain(et as unknown as Record<string, unknown>, actorUri);
			if (!emojiDomain) continue;
			try {
				const result = await env.DB_META_C000.prepare(
					`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
					 ON CONFLICT(shortcode, domain) DO UPDATE SET image_key = excluded.image_key, updated_at = excluded.updated_at`,
				).bind(generateUlid(), emoji.shortcode, emojiDomain, emoji.url, now).run();
				if (result.meta.changes > 0) {
					newEmojis.push({ shortcode: emoji.shortcode, url: emoji.url, static_url: emoji.static_url, domain: emojiDomain });
				}
			} catch {
				// ignore
			}
		}

		// Notify streaming about new emojis
		if (newEmojis.length > 0) {
			try {
				await sendStreamEvent('__public__', {
					event: 'emoji_update',
					payload: JSON.stringify(newEmojis),
					stream: ['public', 'public:local', 'user'],
				});
			} catch {
				// Streaming failure shouldn't block inbox processing
			}
		}
	}

	private async fanoutDM(
		statusId: string,
		authorAccountId: string,
	): Promise<void> {
		interface LocalMentionRow { account_id: string }
		const { results: localMentions } = await env.DB_META_C000.prepare(
			`SELECT m.account_id FROM mentions m
			 JOIN accounts a ON a.id = m.account_id
			 WHERE m.status_id = ?1 AND a.domain IS NULL`,
		).bind(statusId).all<LocalMentionRow>();

		if (!localMentions || localMentions.length === 0) return;

		const permittedLocalMentions: LocalMentionRow[] = [];
		for (const mention of localMentions) {
			if (await canSurfaceStatusToViewer(statusId, mention.account_id)) {
				permittedLocalMentions.push(mention);
			}
		}
		if (permittedLocalMentions.length === 0) return;

		// Send streaming event for DM
		try {
			const dmStatusRow = await env.DB_META_C000.prepare(
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
						id: statusId, uri: dmStatusRow.uri,
						object_type: dmStatusRow.poll_id ? 'Question' : dmStatusRow.object_type,
						title: dmStatusRow.title || '', created_at: dmStatusRow.created_at,
						article_summary: dmStatusRow.object_type === 'Article' ? dmStatusRow.content_warning || '' : '',
						content: dmStatusRow.content, visibility: 'direct',
						sensitive: !!dmStatusRow.sensitive,
						spoiler_text: dmStatusRow.object_type === 'Article' ? '' : dmStatusRow.content_warning || '',
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

				for (const m of permittedLocalMentions) {
					const userRow = await env.DB_META_C000.prepare('SELECT id FROM users WHERE account_id = ?1 LIMIT 1').bind(m.account_id).first<{ id: string }>();
					if (userRow) {
						try {
							await sendStreamEvent(userRow.id, {
								event: 'update',
								payload: dmPayload,
								stream: ['user', 'direct'],
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
	localAccountId: string | null,
	options: CreateProcessorOptions = {},
): Promise<boolean> {
	return new CreateProcessor(localAccountId).process(activity, options);
}
