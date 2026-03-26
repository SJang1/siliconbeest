/**
 * Emoji Reactions API
 *
 * Misskey-compatible emoji reactions for statuses.
 * PUT  /:id/react/:emoji   — Add emoji reaction
 * DELETE /:id/react/:emoji — Remove reaction
 * GET  /:id/reactions       — List reactions for a status
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired, authOptional } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Like, Undo, Emoji as APEmoji, Image as APImage } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import type { CustomEmojiRow } from '../../../../types/db';

const app = new Hono<HonoEnv>();

/**
 * Look up a local custom emoji by shortcode and build a Fedify Emoji tag.
 * Returns null for Unicode emoji or if the shortcode is not found.
 */
async function lookupCustomEmojiTag(
	db: D1Database,
	domain: string,
	emoji: string,
): Promise<{ row: CustomEmojiRow; tag: APEmoji } | null> {
	if (!emoji.startsWith(':') || !emoji.endsWith(':')) return null;
	const shortcode = emoji.slice(1, -1);
	const row = await db
		.prepare('SELECT * FROM custom_emojis WHERE shortcode = ? AND domain IS NULL')
		.bind(shortcode)
		.first<CustomEmojiRow>();
	if (!row) return null;
	const emojiUrl = row.image_key.startsWith('http')
		? row.image_key
		: `https://${domain}/media/${row.image_key}`;
	const tag = new APEmoji({
		id: new URL(`https://${domain}/emojis/${row.shortcode}`),
		name: emoji,
		icon: new APImage({
			url: new URL(emojiUrl),
			mediaType: 'image/png',
		}),
	});
	return { row, tag };
}

// PUT /:id/react/:emoji — Add emoji reaction
app.put('/:id/react/:emoji', authRequired, async (c) => {
	const statusId = c.req.param('id');
	const emoji = decodeURIComponent(c.req.param('emoji'));
	const currentAccountId = c.get('currentUser')!.account_id;
	const domain = c.env.INSTANCE_DOMAIN;

	const row = await c.env.DB.prepare(
		`${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
	)
		.bind(statusId)
		.first();
	if (!row) throw new AppError(404, 'Record not found');

	// Validate custom emoji exists
	const isCustom = emoji.startsWith(':') && emoji.endsWith(':');
	const emojiLookup = await lookupCustomEmojiTag(c.env.DB, domain, emoji);
	if (isCustom && !emojiLookup) {
		throw new AppError(422, 'Custom emoji not found');
	}

	const id = generateUlid();
	const now = new Date().toISOString();

	const customEmojiId = emojiLookup?.row.id ?? null;

	try {
		await c.env.DB.prepare(
			`INSERT INTO emoji_reactions (id, account_id, status_id, emoji, custom_emoji_id, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(id, currentAccountId, statusId, emoji, customEmojiId, now)
			.run();
	} catch {
		// UNIQUE constraint — duplicate reaction, ignore
	}

	// If status author is remote, send Like activity with content (emoji reaction)
	const statusRow = row as Record<string, unknown>;
	const authorDomain = statusRow.account_domain as string | null;
	if (authorDomain) {
		const authorAccountId = statusRow.account_id as string;
		const authorAccount = await c.env.DB.prepare(
			'SELECT uri FROM accounts WHERE id = ?',
		).bind(authorAccountId).first<{ uri: string }>();
		if (authorAccount) {
			const username = c.get('currentAccount')?.username;
			const actorUri = `https://${domain}/users/${username}`;
			const statusUri = statusRow.uri as string;
			const tags = emojiLookup ? [emojiLookup.tag] : [];
			const like = new Like({
				id: new URL(`https://${domain}/activities/${generateUlid()}`),
				actor: new URL(actorUri),
				object: new URL(statusUri),
				content: emoji,
				tags,
			});
			const fed = c.get('federation');
			await sendToRecipient(fed, c.env, username!, authorAccount.uri, like);
		}
	}

	const status = await serializeStatusEnriched(statusRow, c.env.DB, domain, currentAccountId, c.env.CACHE);
	return c.json(status);
});

// DELETE /:id/react/:emoji — Remove reaction
app.delete('/:id/react/:emoji', authRequired, async (c) => {
	const statusId = c.req.param('id');
	const emoji = decodeURIComponent(c.req.param('emoji'));
	const currentAccountId = c.get('currentUser')!.account_id;
	const domain = c.env.INSTANCE_DOMAIN;

	const row = await c.env.DB.prepare(
		`${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
	)
		.bind(statusId)
		.first();
	if (!row) throw new AppError(404, 'Record not found');

	const deleted = await c.env.DB.prepare(
		`DELETE FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2 AND emoji = ?3`,
	)
		.bind(currentAccountId, statusId, emoji)
		.run();

	// If status author is remote, send Undo(Like) for emoji reaction
	const statusRow = row as Record<string, unknown>;
	const authorDomain = statusRow.account_domain as string | null;
	if (authorDomain && (deleted.meta?.changes ?? 0) > 0) {
		const authorAccountId = statusRow.account_id as string;
		const authorAccount = await c.env.DB.prepare(
			'SELECT uri FROM accounts WHERE id = ?',
		).bind(authorAccountId).first<{ uri: string }>();
		if (authorAccount) {
			const username = c.get('currentAccount')?.username;
			const actorUri = `https://${domain}/users/${username}`;
			const statusUri = statusRow.uri as string;
			const emojiLookup = await lookupCustomEmojiTag(c.env.DB, domain, emoji);
			const tags = emojiLookup ? [emojiLookup.tag] : [];
			const originalLike = new Like({
				id: new URL(`https://${domain}/activities/${generateUlid()}`),
				actor: new URL(actorUri),
				object: new URL(statusUri),
				content: emoji,
				tags,
			});
			const undo = new Undo({
				id: new URL(`https://${domain}/activities/${generateUlid()}`),
				actor: new URL(actorUri),
				object: originalLike,
			});
			const fed = c.get('federation');
			await sendToRecipient(fed, c.env, username!, authorAccount.uri, undo);
		}
	}

	const status = await serializeStatusEnriched(statusRow, c.env.DB, domain, currentAccountId, c.env.CACHE);
	return c.json(status);
});

// GET /:id/reactions — List reactions for a status
app.get('/:id/reactions', authOptional, async (c) => {
	const statusId = c.req.param('id');
	const currentAccountId = c.get('currentUser')?.account_id ?? null;
	const domain = c.env.INSTANCE_DOMAIN;

	// Verify status exists
	const status = await c.env.DB.prepare(
		'SELECT id FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
	)
		.bind(statusId)
		.first();
	if (!status) throw new AppError(404, 'Record not found');

	// Fetch all reactions with account info and custom emoji data via LEFT JOIN
	const { results } = await c.env.DB.prepare(
		`SELECT er.emoji, er.account_id,
		   a.username, a.domain, a.display_name, a.note, a.uri, a.url,
		   a.avatar_url, a.avatar_static_url, a.header_url, a.header_static_url,
		   a.locked, a.bot, a.discoverable,
		   a.followers_count, a.following_count, a.statuses_count,
		   a.last_status_at, a.created_at,
		   ce.shortcode AS ce_shortcode, ce.domain AS ce_domain, ce.image_key AS ce_image_key
		 FROM emoji_reactions er
		 JOIN accounts a ON a.id = er.account_id
		 LEFT JOIN custom_emojis ce ON ce.id = er.custom_emoji_id
		 WHERE er.status_id = ?1
		 ORDER BY er.created_at ASC`,
	)
		.bind(statusId)
		.all();

	// Build emoji URL map from the JOIN results (no extra queries needed)
	const emojiUrlMap = new Map<string, { url: string; static_url: string }>();
	for (const row of results ?? []) {
		const shortcode = row.ce_shortcode as string | null;
		const imageKey = row.ce_image_key as string | null;
		if (!shortcode || !imageKey) continue;
		if (emojiUrlMap.has(shortcode)) continue;
		const emojiDomain = row.ce_domain as string | null;
		let url: string;
		if (emojiDomain) {
			// Remote custom emoji — proxy to protect user IPs
			const originalUrl = imageKey.startsWith('http') ? imageKey : `https://${emojiDomain}/${imageKey}`;
			url = `https://${domain}/proxy?url=${encodeURIComponent(originalUrl)}`;
		} else {
			// Local custom emoji — serve directly from media
			url = imageKey.startsWith('http') ? imageKey : `https://${domain}/media/${imageKey}`;
		}
		emojiUrlMap.set(shortcode, { url, static_url: url });
	}

	// Fallback: for reactions without custom_emoji_id set (e.g., older data), look up by shortcode
	const missingShortcodes = new Set<string>();
	for (const row of results ?? []) {
		const emoji = row.emoji as string;
		if (emoji.startsWith(':') && emoji.endsWith(':')) {
			const sc = emoji.slice(1, -1);
			if (!emojiUrlMap.has(sc)) missingShortcodes.add(sc);
		}
	}
	if (missingShortcodes.size > 0) {
		const shortcodes = [...missingShortcodes];
		const emojiPlaceholders = shortcodes.map(() => '?').join(',');
		const { results: emojiRows } = await c.env.DB.prepare(
			`SELECT shortcode, domain, image_key FROM custom_emojis WHERE shortcode IN (${emojiPlaceholders})`,
		).bind(...shortcodes).all();
		for (const er of emojiRows ?? []) {
			const sc = er.shortcode as string;
			const imageKey = er.image_key as string;
			const emojiDomain = er.domain as string | null;
			let url: string;
			if (emojiDomain) {
				const originalUrl = imageKey.startsWith('http') ? imageKey : `https://${emojiDomain}/${imageKey}`;
				url = `https://${domain}/proxy?url=${encodeURIComponent(originalUrl)}`;
			} else {
				url = imageKey.startsWith('http') ? imageKey : `https://${domain}/media/${imageKey}`;
			}
			emojiUrlMap.set(sc, { url, static_url: url });
		}
	}

	// Group by emoji
	const emojiMap = new Map<
		string,
		{
			name: string;
			count: number;
			me: boolean;
			url: string | null;
			static_url: string | null;
			accounts: Record<string, unknown>[];
		}
	>();

	for (const row of results ?? []) {
		const emoji = row.emoji as string;
		if (!emojiMap.has(emoji)) {
			let emojiInfo: { url: string | null; static_url: string | null } = { url: null, static_url: null };
			if (emoji.startsWith(':') && emoji.endsWith(':')) {
				const sc = emoji.slice(1, -1);
				const info = emojiUrlMap.get(sc);
				if (info) emojiInfo = info;
			}
			emojiMap.set(emoji, { name: emoji, count: 0, me: false, url: emojiInfo.url, static_url: emojiInfo.static_url, accounts: [] });
		}
		const entry = emojiMap.get(emoji)!;
		entry.count += 1;

		if (currentAccountId && row.account_id === currentAccountId) {
			entry.me = true;
		}

		const acct = row.domain
			? `${row.username}@${row.domain}`
			: (row.username as string);

		entry.accounts.push({
			id: row.account_id as string,
			username: row.username as string,
			acct,
			display_name: (row.display_name as string) || '',
			locked: !!row.locked,
			bot: !!row.bot,
			discoverable: !!row.discoverable,
			group: false,
			created_at: row.created_at as string,
			note: (row.note as string) || '',
			url:
				(row.url as string) ||
				`https://${domain}/@${row.username}`,
			uri: row.uri as string,
			avatar: (row.avatar_url as string) || null,
			avatar_static: (row.avatar_static_url as string) || null,
			header: (row.header_url as string) || null,
			header_static: (row.header_static_url as string) || null,
			followers_count: (row.followers_count as number) || 0,
			following_count: (row.following_count as number) || 0,
			statuses_count: (row.statuses_count as number) || 0,
			last_status_at: (row.last_status_at as string) || null,
			emojis: [],
			fields: [],
		});
	}

	return c.json(Array.from(emojiMap.values()));
});

export default app;
