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

import { env } from 'cloudflare:workers';
import { isActor } from '@fedify/fedify/vocab';
import { generateUlid } from '../utils/ulid';
import { isDomainBlocked } from './helpers/domainBlock';
import { sanitizeHtml } from '../utils/sanitize';
import { createFed } from './fedify';
import { getFedifyContext } from './helpers/send';

export async function resolveRemoteAccount(
	actorUri: string,
): Promise<string | null> {
	const existing = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(actorUri)
		.first<{ id: string }>();

	if (existing) return existing.id;

	// Fetch the actor document to get the real preferredUsername
	let username = '';
	let domain = 'unknown';
	let displayName = '';
	let inboxUrl: string | null = null;
	let sharedInboxUrl: string | null = null;
	let avatarUrl = '';
	let headerUrl = '';
	let summary = '';
	let actorUrl = '';
	let resolved = false;

	try {
		const url = new URL(actorUri);
		domain = url.host;
	} catch {
		// leave default
	}

	// Check domain blocks before fetching
	const blockResult = await isDomainBlocked(env.DB, env.CACHE ?? null, domain);
	if (blockResult.blocked) {
		console.log(`[resolveRemoteAccount] Refusing to resolve account from suspended domain: ${domain}`);
		return null;
	}

	try {
		const fed = createFed();
		const ctx = getFedifyContext(fed);
		const localAcct = await env.DB.prepare(
			"SELECT username FROM accounts WHERE domain IS NULL LIMIT 1",
		).first<{ username: string }>();
		const docLoader = await ctx.getDocumentLoader({
			identifier: localAcct?.username || 'admin',
		});
		const actorObj = await ctx.lookupObject(actorUri, { documentLoader: docLoader });
		if (actorObj && isActor(actorObj)) {
			resolved = true;
			username = (actorObj.preferredUsername ?? '') as string;
			displayName = (actorObj.name?.toString() ?? '') as string;
			summary = sanitizeHtml(actorObj.summary?.toString() ?? '');
			actorUrl = String(actorObj.url ?? actorUri);
			inboxUrl = actorObj.inboxId?.href ?? null;
			sharedInboxUrl = actorObj.endpoints?.sharedInbox?.href ?? null;

			const icon = await actorObj.getIcon();
			if (icon?.url) avatarUrl = String(icon.url);
			const image = await actorObj.getImage();
			if (image?.url) headerUrl = String(image.url);
		} else {
			console.warn(`[resolveRemoteAccount] Could not resolve actor via Fedify: ${actorUri}`);
		}
	} catch (e) {
		console.warn(`[resolveRemoteAccount] Error fetching actor ${actorUri}:`, e);
	}

	// If we don't have a username yet, try to extract from URI path
	if (!username) {
		try {
			const url = new URL(actorUri);
			const segments = url.pathname.split('/').filter(Boolean);
			username = segments[segments.length - 1] ?? '';
		} catch { /* leave empty */ }
	}

	// Only create accounts when Fedify confirmed the actor exists
	if (!resolved) {
		console.warn(`[resolveRemoteAccount] Could not verify actor ${actorUri}, skipping account creation`);
		return null;
	}
	if (!username) {
		console.warn(`[resolveRemoteAccount] No username for ${actorUri}, skipping account creation`);
		return null;
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
