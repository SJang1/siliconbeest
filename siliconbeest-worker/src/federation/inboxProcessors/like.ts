/**
 * Inbox Processor: Like
 *
 * Handles incoming Like activities. Inserts a favourite record,
 * increments the favourites_count on the status, and creates
 * a notification for the status author.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';

/**
 * Resolve or upsert a remote account by actor URI.
 */
async function resolveRemoteAccount(
	actorUri: string,
	env: Env,
): Promise<string | null> {
	const existing = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(actorUri)
		.first<{ id: string }>();

	if (existing) return existing.id;

	const now = new Date().toISOString();
	const id = generateUlid();
	let username = 'unknown';
	let domain = 'unknown';

	try {
		const url = new URL(actorUri);
		domain = url.host;
		const segments = url.pathname.split('/').filter(Boolean);
		username = segments[segments.length - 1] ?? 'unknown';
	} catch {
		// leave defaults
	}

	try {
		await env.DB.prepare(
			`INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(id, username, domain, actorUri, now, now)
			.run();
	} catch {
		const retry = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
		)
			.bind(actorUri)
			.first<{ id: string }>();
		return retry?.id ?? null;
	}

	await env.QUEUE_FEDERATION.send({
		type: 'fetch_remote_account',
		actorUri,
	});

	return id;
}

export async function processLike(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const statusUri =
		typeof activity.object === 'string' ? activity.object : undefined;

	if (!statusUri) {
		console.warn('[like] activity.object is not a string URI');
		return;
	}

	// Find the status being liked
	const status = await env.DB.prepare(
		`SELECT id, account_id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(statusUri)
		.first<{ id: string; account_id: string }>();

	if (!status) {
		console.log(`[like] Status not found: ${statusUri}`);
		return;
	}

	// Resolve the remote actor
	const actorAccountId = await resolveRemoteAccount(activity.actor, env);
	if (!actorAccountId) {
		console.error('[like] Could not resolve remote actor');
		return;
	}

	// Insert favourite (ignore duplicate)
	const favId = generateUlid();
	const now = new Date().toISOString();

	try {
		await env.DB.prepare(
			`INSERT INTO favourites (id, account_id, status_id, uri, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)`,
		)
			.bind(favId, actorAccountId, status.id, activity.id ?? null, now)
			.run();
	} catch {
		// Duplicate favourite, ignore
		return;
	}

	// Increment favourites_count
	await env.DB.prepare(
		`UPDATE statuses SET favourites_count = favourites_count + 1 WHERE id = ?1`,
	)
		.bind(status.id)
		.run();

	// Create notification for the status author (only if local)
	const isLocalAuthor = await env.DB.prepare(
		`SELECT id FROM accounts WHERE id = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(status.account_id)
		.first();

	if (isLocalAuthor) {
		await env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId: status.account_id,
			senderAccountId: actorAccountId,
			notificationType: 'favourite',
			statusId: status.id,
		});
	}
}
