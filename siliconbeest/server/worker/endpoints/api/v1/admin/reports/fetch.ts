import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/reports/:id — single report details.
 *
 * Joins reporter and target_account with full account info.
 * Parses status_ids from the report row (JSON array) and fetches
 * full status objects with account info and media_attachments.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const domain = env.INSTANCE_DOMAIN;

	const row = await env.DB.prepare(
		`SELECT r.*,
			a1.username AS reporter_username, a1.domain AS reporter_domain,
			a1.display_name AS reporter_display_name, a1.avatar_url AS reporter_avatar_url,
			a1.url AS reporter_url, a1.uri AS reporter_uri,
			a2.username AS target_username, a2.domain AS target_domain,
			a2.display_name AS target_display_name, a2.avatar_url AS target_avatar_url,
			a2.url AS target_url, a2.uri AS target_uri,
			a2.locked AS target_locked, a2.bot AS target_bot,
			a2.discoverable AS target_discoverable, a2.note AS target_note,
			a2.followers_count AS target_followers_count,
			a2.following_count AS target_following_count,
			a2.statuses_count AS target_statuses_count,
			a2.header_url AS target_header_url,
			a2.header_static_url AS target_header_static_url,
			a2.last_status_at AS target_last_status_at
		FROM reports r
		LEFT JOIN accounts a1 ON a1.id = r.account_id
		LEFT JOIN accounts a2 ON a2.id = r.target_account_id
		WHERE r.id = ?1`,
	)
		.bind(id)
		.first();

	if (!row) throw new AppError(404, 'Record not found');

	// Parse status_ids from the report row (stored as JSON array)
	let statuses: Record<string, unknown>[] = [];
	const rawStatusIds = row.status_ids as string | null;
	if (rawStatusIds) {
		try {
			const statusIds: string[] = JSON.parse(rawStatusIds);
			if (statusIds.length > 0) {
				// Build placeholders for IN clause
				const placeholders = statusIds.map((_, i) => `?${i + 1}`).join(',');
				const { results: statusRows } = await env.DB.prepare(
					`SELECT s.*, a.username AS author_username, a.domain AS author_domain,
						a.display_name AS author_display_name, a.avatar_url AS author_avatar_url,
						a.url AS author_url, a.uri AS author_uri
					FROM statuses s
					LEFT JOIN accounts a ON a.id = s.account_id
					WHERE s.id IN (${placeholders}) AND s.deleted_at IS NULL`,
				)
					.bind(...statusIds)
					.all();

				// Fetch media attachments for all statuses
				const statusIdSet = (statusRows || []).map((s) => s.id as string);
				let mediaMap: Record<string, Record<string, unknown>[]> = {};
				if (statusIdSet.length > 0) {
					const mediaPlaceholders = statusIdSet.map((_, i) => `?${i + 1}`).join(',');
					const { results: mediaRows } = await env.DB.prepare(
						`SELECT * FROM media_attachments WHERE status_id IN (${mediaPlaceholders})`,
					)
						.bind(...statusIdSet)
						.all();
					for (const m of mediaRows || []) {
						const sid = m.status_id as string;
						if (!mediaMap[sid]) mediaMap[sid] = [];
						mediaMap[sid].push({
							id: m.id as string,
							type: (m.type as string) || 'image',
							url: m.file_key ? `https://${domain}/media/${m.file_key}` : (m.remote_url as string) || '',
							preview_url: m.thumbnail_key
								? `https://${domain}/media/${m.thumbnail_key}`
								: m.file_key
									? `https://${domain}/media/${m.file_key}`
									: (m.remote_url as string) || '',
							remote_url: (m.remote_url as string) || null,
							description: (m.description as string) || null,
							blurhash: (m.blurhash as string) || null,
						});
					}
				}

				statuses = (statusRows || []).map((s) => {
					const authorDomain = s.author_domain as string | null;
					const authorUsername = s.author_username as string;
					const acct = authorDomain ? `${authorUsername}@${authorDomain}` : authorUsername;
					const authorUrl =
						(s.author_url as string) ||
						(authorDomain ? (s.author_uri as string) : `https://${domain}/@${authorUsername}`);
					return {
						id: s.id as string,
						created_at: s.created_at as string,
						in_reply_to_id: (s.in_reply_to_id as string) || null,
						in_reply_to_account_id: (s.in_reply_to_account_id as string) || null,
						sensitive: !!(s.sensitive),
						spoiler_text: (s.content_warning as string) || '',
						visibility: (s.visibility as string) || 'public',
						language: (s.language as string) || null,
						uri: s.uri as string,
						url: (s.url as string) || s.uri as string,
						content: (s.content as string) || '',
						account: {
							id: s.account_id as string,
							username: authorUsername,
							acct,
							display_name: (s.author_display_name as string) || '',
							url: authorUrl,
							avatar: (s.author_avatar_url as string) || '',
							avatar_static: (s.author_avatar_url as string) || '',
						},
						media_attachments: mediaMap[s.id as string] || [],
						emojis: [],
					};
				});
			}
		} catch {
			// If status_ids is malformed, return empty array
		}
	}

	return c.json({
		id: row.id as string,
		action_taken: !!(row.action_taken_at),
		action_taken_at: (row.action_taken_at as string) || null,
		category: (row.category as string) || 'other',
		comment: (row.comment as string) || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || (row.created_at as string),
		account: formatAccount(row, 'reporter', domain),
		target_account: formatTargetAccount(row, domain),
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id as string } : null,
		action_taken_by_account: row.action_taken_by_account_id
			? { id: row.action_taken_by_account_id as string }
			: null,
		statuses,
		rules: [],
	});
});

function formatAccount(row: Record<string, unknown>, prefix: string, instanceDomain: string) {
	const username = row[`${prefix}_username`] as string;
	const domain = row[`${prefix}_domain`] as string | null;
	const acct = domain ? `${username}@${domain}` : username;
	const url =
		(row[`${prefix}_url`] as string) ||
		(domain ? (row[`${prefix}_uri`] as string) : `https://${instanceDomain}/@${username}`);
	return {
		id: row.account_id as string,
		username,
		acct,
		display_name: (row[`${prefix}_display_name`] as string) || '',
		url,
		avatar: (row[`${prefix}_avatar_url`] as string) || '',
		avatar_static: (row[`${prefix}_avatar_url`] as string) || '',
	};
}

function formatTargetAccount(row: Record<string, unknown>, instanceDomain: string) {
	const username = row.target_username as string;
	const domain = row.target_domain as string | null;
	const acct = domain ? `${username}@${domain}` : username;
	const url =
		(row.target_url as string) ||
		(domain ? (row.target_uri as string) : `https://${instanceDomain}/@${username}`);
	return {
		id: row.target_account_id as string,
		username,
		acct,
		display_name: (row.target_display_name as string) || '',
		url,
		avatar: (row.target_avatar_url as string) || '',
		avatar_static: (row.target_avatar_url as string) || '',
		locked: !!(row.target_locked),
		bot: !!(row.target_bot),
		discoverable: !!(row.target_discoverable),
		note: (row.target_note as string) || '',
		followers_count: (row.target_followers_count as number) || 0,
		following_count: (row.target_following_count as number) || 0,
		statuses_count: (row.target_statuses_count as number) || 0,
		last_status_at: (row.target_last_status_at as string) || null,
	};
}

export default app;
