/**
 * Shared utility: resolveRemoteAccount
 *
 * Resolves or upserts a remote account by its ActivityPub actor URI.
 * Fetches the actor document to get the real preferredUsername (critical
 * for Misskey/Firefish/CherryPick where the URI path contains an
 * internal ID, not the real username).
 *
 * Returns the account ID, or null if resolution fails entirely.
 */

import type { Env } from '../env';
import { generateUlid } from '../utils/ulid';

export async function resolveRemoteAccount(
	actorUri: string,
	env: Env,
): Promise<string | null> {
	const existing = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(actorUri)
		.first<{ id: string }>();

	if (existing) return existing.id;

	// Fetch the actor document to get the real preferredUsername
	let username = 'unknown';
	let domain = 'unknown';
	let displayName = '';
	let inboxUrl: string | null = null;
	let sharedInboxUrl: string | null = null;
	let avatarUrl = '';
	let headerUrl = '';
	let summary = '';
	let actorUrl = '';

	try {
		const url = new URL(actorUri);
		domain = url.host;
	} catch {
		// leave default
	}

	try {
		const res = await fetch(actorUri, {
			headers: { Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
		});
		if (res.ok) {
			const actor = await res.json() as Record<string, unknown>;
			username = (actor.preferredUsername as string) || username;
			displayName = (actor.name as string) || '';
			summary = (actor.summary as string) || '';
			actorUrl = (actor.url as string) || actorUri;
			inboxUrl = (actor.inbox as string) || null;
			const endpoints = actor.endpoints as Record<string, unknown> | undefined;
			sharedInboxUrl = (endpoints?.sharedInbox as string) || null;

			const icon = actor.icon as Record<string, unknown> | undefined;
			if (icon?.url) avatarUrl = icon.url as string;
			const image = actor.image as Record<string, unknown> | undefined;
			if (image?.url) headerUrl = image.url as string;
		}
	} catch {
		// Fallback: extract from URI path
		try {
			const url = new URL(actorUri);
			const segments = url.pathname.split('/').filter(Boolean);
			username = segments[segments.length - 1] ?? 'unknown';
		} catch { /* leave defaults */ }
	}

	const now = new Date().toISOString();
	const id = generateUlid();

	try {
		await env.DB.prepare(
			`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url, header_url, header_static_url, inbox_url, shared_inbox_url, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, ?10, ?11, ?12, ?12)`,
		)
			.bind(id, username, domain, displayName, summary, actorUri, actorUrl || actorUri, avatarUrl, headerUrl, inboxUrl, sharedInboxUrl, now)
			.run();
	} catch {
		const retry = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
		)
			.bind(actorUri)
			.first<{ id: string }>();
		return retry?.id ?? null;
	}

	// Also enqueue a full fetch for any fields we might have missed
	await env.QUEUE_FEDERATION.send({
		type: 'fetch_remote_account',
		actorUri,
	});

	return id;
}
