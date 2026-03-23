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
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { buildEmojiReactActivity, buildUndoActivity } from '../../../../federation/activityBuilder';
import { enqueueDelivery } from '../../../../federation/deliveryManager';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function generateULID(): string {
	const t = Date.now();
	const ts = t.toString(36).padStart(10, '0');
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
		.map((b) => (b % 36).toString(36))
		.join('');
	return (ts + rand).toUpperCase();
}

const app = new Hono<HonoEnv>();

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

	const id = generateULID();
	const now = new Date().toISOString();

	try {
		await c.env.DB.prepare(
			`INSERT INTO emoji_reactions (id, account_id, status_id, emoji, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)`,
		)
			.bind(id, currentAccountId, statusId, emoji, now)
			.run();
	} catch {
		// UNIQUE constraint — duplicate reaction, ignore
	}

	// If status author is remote, enqueue Like activity with _misskey_reaction
	const statusRow = row as Record<string, unknown>;
	const authorDomain = statusRow.account_domain as string | null;
	if (authorDomain) {
		const authorAccountId = statusRow.account_id as string;
		const authorAccount = await c.env.DB.prepare(
			'SELECT inbox_url, shared_inbox_url FROM accounts WHERE id = ?',
		).bind(authorAccountId).first<{ inbox_url: string | null; shared_inbox_url: string | null }>();
		const inbox = authorAccount?.shared_inbox_url || authorAccount?.inbox_url;
		if (inbox) {
			const actorUri = `https://${domain}/users/${c.get('currentAccount')?.username}`;
			const statusUri = statusRow.uri as string;
			const activity = buildEmojiReactActivity(actorUri, statusUri, emoji);
			await enqueueDelivery(c.env.QUEUE_FEDERATION, JSON.stringify(activity), inbox, currentAccountId);
		}
	}

	const status = await serializeStatusEnriched(statusRow, c.env.DB, domain, currentAccountId);
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

	// If status author is remote, enqueue Undo(Like) with _misskey_reaction
	const statusRow = row as Record<string, unknown>;
	const authorDomain = statusRow.account_domain as string | null;
	if (authorDomain && (deleted.meta?.changes ?? 0) > 0) {
		const authorAccountId = statusRow.account_id as string;
		const authorAccount = await c.env.DB.prepare(
			'SELECT inbox_url, shared_inbox_url FROM accounts WHERE id = ?',
		).bind(authorAccountId).first<{ inbox_url: string | null; shared_inbox_url: string | null }>();
		const inbox = authorAccount?.shared_inbox_url || authorAccount?.inbox_url;
		if (inbox) {
			const actorUri = `https://${domain}/users/${c.get('currentAccount')?.username}`;
			const statusUri = statusRow.uri as string;
			const likeActivity = buildEmojiReactActivity(actorUri, statusUri, emoji);
			const undoActivity = buildUndoActivity(actorUri, likeActivity);
			await enqueueDelivery(c.env.QUEUE_FEDERATION, JSON.stringify(undoActivity), inbox, currentAccountId);
		}
	}

	const status = await serializeStatusEnriched(statusRow, c.env.DB, domain, currentAccountId);
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

	// Fetch all reactions with account info, grouped by emoji
	const { results } = await c.env.DB.prepare(
		`SELECT er.emoji, er.account_id,
		   a.username, a.domain, a.display_name, a.note, a.uri, a.url,
		   a.avatar_url, a.avatar_static_url, a.header_url, a.header_static_url,
		   a.locked, a.bot, a.discoverable,
		   a.followers_count, a.following_count, a.statuses_count,
		   a.last_status_at, a.created_at
		 FROM emoji_reactions er
		 JOIN accounts a ON a.id = er.account_id
		 WHERE er.status_id = ?1
		 ORDER BY er.created_at ASC`,
	)
		.bind(statusId)
		.all();

	// Collect unique custom emoji shortcodes (those with colons like :blobcat:)
	const customEmojiShortcodes = new Set<string>();
	for (const row of results ?? []) {
		const emoji = row.emoji as string;
		if (emoji.startsWith(':') && emoji.endsWith(':')) {
			customEmojiShortcodes.add(emoji.slice(1, -1));
		}
	}

	// Fetch custom emoji URLs from DB
	const emojiUrlMap = new Map<string, { url: string; static_url: string }>();
	if (customEmojiShortcodes.size > 0) {
		const shortcodes = [...customEmojiShortcodes];
		const emojiPlaceholders = shortcodes.map(() => '?').join(',');
		const { results: emojiRows } = await c.env.DB.prepare(
			`SELECT shortcode, image_key FROM custom_emojis WHERE shortcode IN (${emojiPlaceholders})`,
		).bind(...shortcodes).all();
		for (const er of emojiRows ?? []) {
			const sc = er.shortcode as string;
			const imageKey = er.image_key as string;
			// image_key is either a full URL (remote) or an R2 key (local)
			const url = imageKey.startsWith('http') ? imageKey : `https://${domain}/media/${imageKey}`;
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
