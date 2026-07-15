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
import { sanitizeHtml } from '../utils/sanitize';
import { createFed } from './fedify';
import { getFedifyContext } from './helpers/send';
import { pickSignerUsername } from '../../../../packages/shared/services/signer';
import { emojiTagToCustomEmoji } from '../../../../packages/shared/utils/customEmoji';
import { getSuspendedDomains } from '../../../../packages/shared/domain-blocks';

/**
 * Resolve or upsert a remote ActivityPub account.
 *
 * @param actorUri        ActivityPub actor URI to resolve.
 * @param signerAccountId Account ID providing the contextual signer
 *                        (inbox recipient or authenticated user). When
 *                        omitted, falls back to the oldest local user.
 */
export async function resolveRemoteAccount(
	actorUri: string,
	signerAccountId: string | null = null,
): Promise<string | null> {
	// URI hosts are case-insensitive (DNS): normalize through the WHATWG URL
	// parser (lowercases scheme+host, preserves path case) so the dedup lookup
	// matches the stored canonical form. The raw input is checked too, because
	// rows written before this normalization may carry an unnormalized uri.
	let lookupUri = actorUri;
	try { lookupUri = new URL(actorUri).href; } catch { /* keep raw */ }

	const existing = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri IN (?1, ?2) LIMIT 1`,
	)
		.bind(lookupUri, actorUri)
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
	let emojiTagsJson: string | null = null;
	let resolved = false;
	// The actor's own id is the canonical AP identity — store and enqueue that,
	// not the (possibly differently-cased) reference URI we were handed.
	let canonicalUri = lookupUri;

	try {
		const url = new URL(actorUri);
		domain = url.host;
	} catch {
		// leave default
	}

	// Check domain blocks before fetching
	const suspendedDomains = await getSuspendedDomains(env.DB, [domain]);
	if (suspendedDomains.has(domain.toLowerCase())) {
		console.log(`[resolveRemoteAccount] Refusing to resolve account from suspended domain: ${domain}`);
		return null;
	}

	try {
		const fed = createFed();
		const ctx = getFedifyContext(fed);
		const signerUsername = await pickSignerUsername(env.DB, signerAccountId);
		if (!signerUsername) {
			console.warn(`[resolveRemoteAccount] No local signer available for ${actorUri}, skipping`);
			return null;
		}
		const docLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
		const actorObj = await ctx.lookupObject(actorUri, { documentLoader: docLoader });
		if (actorObj && isActor(actorObj)) {
			resolved = true;
			canonicalUri = actorObj.id?.href ?? lookupUri;
			username = (actorObj.preferredUsername ?? '') as string;
			displayName = (actorObj.name?.toString() ?? '') as string;
			summary = sanitizeHtml(actorObj.summary?.toString() ?? '');
			actorUrl = String(actorObj.url ?? actorUri);
			inboxUrl = actorObj.inboxId?.href ?? null;
			sharedInboxUrl = actorObj.endpoints?.sharedInbox?.href ?? null;

			const icon = await actorObj.getIcon({ documentLoader: docLoader });
			if (icon?.url) avatarUrl = String(icon.url);
			const image = await actorObj.getImage({ documentLoader: docLoader });
			if (image?.url) headerUrl = String(image.url);

			const actorDoc = await actorObj.toJsonLd() as Record<string, unknown>;
			const tags = actorDoc.tag as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(tags)) {
				const emojis = tags
					.filter((tag) => tag.type === 'Emoji')
					.map((tag) => emojiTagToCustomEmoji(tag))
					.filter((emoji): emoji is NonNullable<typeof emoji> => !!emoji)
					.map((emoji) => ({ shortcode: emoji.shortcode, url: emoji.url, static_url: emoji.static_url }));
				emojiTagsJson = emojis.length > 0 ? JSON.stringify(emojis) : null;
			}
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

	// The canonical id may differ from the reference URI we were handed (e.g.
	// host casing, or a forwarded/alternate URI). Dedup again by the canonical
	// id and re-derive the domain from it before inserting.
	if (canonicalUri !== lookupUri) {
		const byCanonical = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
		)
			.bind(canonicalUri)
			.first<{ id: string }>();
		if (byCanonical) return byCanonical.id;

		try {
			const canonicalHost = new URL(canonicalUri).host;
			if (canonicalHost !== domain) {
				domain = canonicalHost;
				const canonicalSuspendedDomains = await getSuspendedDomains(env.DB, [domain]);
				if (canonicalSuspendedDomains.has(domain.toLowerCase())) {
					console.log(`[resolveRemoteAccount] Refusing to resolve account from suspended domain: ${domain}`);
					return null;
				}
			}
		} catch { /* keep the domain derived from the reference URI */ }
	}

	const now = new Date().toISOString();
	const id = generateUlid();

	try {
		await env.DB.prepare(
			`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url, header_url, header_static_url, inbox_url, shared_inbox_url, emoji_tags, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?13)`,
		)
			.bind(id, username, domain, displayName, summary, canonicalUri, actorUrl || canonicalUri, avatarUrl, headerUrl, inboxUrl, sharedInboxUrl, emojiTagsJson, now)
			.run();
	} catch {
		const retry = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri IN (?1, ?2) LIMIT 1`,
		)
			.bind(canonicalUri, actorUri)
			.first<{ id: string }>();
		return retry?.id ?? null;
	}

	// Also enqueue a full fetch for any fields we might have missed
	await env.QUEUE_FEDERATION.send({
		type: 'fetch_remote_account',
		actorUri: canonicalUri,
		...(signerAccountId ? { signerAccountId } : {}),
	});

	return id;
}
