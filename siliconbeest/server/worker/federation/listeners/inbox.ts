/**
 * Fedify Inbox Listener Registration
 *
 * Wires up Fedify's `setInboxListeners` to the 13 inbox processors.
 * Each listener extracts fields directly from Fedify's typed objects
 * and constructs the APActivity format inline, eliminating the need
 * for the activity-adapter.ts bridging layer.
 */

import type { Federation, InboxContext } from '@fedify/fedify';
import {
	Follow,
	Create,
	Like,
	Announce,
	Delete,
	Update,
	Undo,
	Block,
	Flag,
	Move,
	Accept,
	Reject,
	EmojiReact,
	type Activity,
} from '@fedify/vocab';

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import type { FedifyContextData } from '../fedify';
import { isDomainBlocked, extractDomain } from '../helpers/domainBlock';

// Import existing processors
import { processFollow } from '../inboxProcessors/follow';
import { processCreate } from '../inboxProcessors/create';
import { processAccept } from '../inboxProcessors/accept';
import { processReject } from '../inboxProcessors/reject';
import { processLike } from '../inboxProcessors/like';
import { processAnnounce } from '../inboxProcessors/announce';
import { processDelete } from '../inboxProcessors/delete';
import { processUpdate } from '../inboxProcessors/update';
import { processUndo } from '../inboxProcessors/undo';
import { processBlock } from '../inboxProcessors/block';
import { processMove } from '../inboxProcessors/move';
import { processFlag } from '../inboxProcessors/flag';
import { processEmojiReact } from '../inboxProcessors/emojiReact';

// ============================================================
// HELPER: Resolve local account ID from inbox recipient
// ============================================================

async function resolveRecipientAccountId(
	ctx: InboxContext<FedifyContextData>,
	env: Env,
): Promise<string | null> {
	if (!ctx.recipient) {
		return ''; // Shared inbox
	}

	const username = ctx.recipient;
	const row = await env.DB.prepare(
		'SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1',
	)
		.bind(username)
		.first<{ id: string }>();

	if (!row) {
		console.warn(`[inbox] Could not resolve account for recipient: ${username}`);
		return null;
	}

	return row.id;
}

// ============================================================
// HELPER: Check if the actor's domain is blocked
// ============================================================

async function isActorDomainSuspended(
	actorId: URL | null,
	env: Env,
): Promise<boolean> {
	if (!actorId) return false;
	const domain = extractDomain(actorId.href);
	if (!domain) return false;
	const result = await isDomainBlocked(env.DB, env.CACHE, domain);
	if (result.blocked) {
		console.log(`[inbox] Dropping activity from suspended domain: ${domain}`);
		return true;
	}
	return false;
}

// ============================================================
// HELPER: Build APActivity from Fedify typed objects
// ============================================================

/**
 * Build a simple APActivity from a Fedify typed activity.
 * Used for activities where object is a string URI (Follow, Like, etc.)
 */
function buildSimpleActivity(
	type: string,
	activity: Activity,
): APActivity {
	return {
		type,
		id: activity.id?.href,
		actor: activity.actorId?.href ?? '',
		object: (activity as any).objectId?.href,
	} as APActivity;
}

/**
 * Build an APActivity from raw JSON-LD for complex activities.
 * Normalizes JSON-LD quirks inline without the adapter layer.
 */
function buildActivityFromJsonLd(jsonLd: Record<string, unknown>): APActivity {
	const activity: Record<string, unknown> = {};

	if (jsonLd['@context']) activity['@context'] = jsonLd['@context'];

	activity.id = normalizeToString(jsonLd.id ?? jsonLd['@id']);

	const rawType = jsonLd.type ?? jsonLd['@type'];
	if (typeof rawType === 'string') {
		activity.type = extractLocalName(rawType);
	} else if (Array.isArray(rawType) && rawType.length > 0) {
		activity.type = extractLocalName(String(rawType[0]));
	}

	activity.actor = normalizeToString(jsonLd.actor) ?? '';

	if (jsonLd.object !== undefined) {
		activity.object = normalizeObjectValue(jsonLd.object);
	}
	if (jsonLd.target !== undefined) {
		activity.target = normalizeObjectValue(jsonLd.target);
	}

	const to = normalizeToStringArray(jsonLd.to);
	if (to) activity.to = to;
	const cc = normalizeToStringArray(jsonLd.cc);
	if (cc) activity.cc = cc;

	if (typeof jsonLd.published === 'string') activity.published = jsonLd.published;
	if (typeof jsonLd.content === 'string') activity.content = jsonLd.content;

	if (jsonLd.signature) activity.signature = jsonLd.signature;
	if (jsonLd.proof) activity.proof = jsonLd.proof;
	if (jsonLd.tag) activity.tag = jsonLd.tag;

	// Preserve vendor extensions
	for (const key of Object.keys(jsonLd)) {
		if (key.startsWith('_misskey_') || key === 'quoteUri') {
			activity[key] = jsonLd[key];
		}
	}

	return activity as unknown as APActivity;
}

// ============================================================
// JSON-LD NORMALIZATION (inlined from removed activity-adapter.ts)
// ============================================================

function normalizeToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		const first = value[0];
		if (typeof first === 'string') return first;
		if (first && typeof first === 'object' && '@id' in first) {
			return (first as Record<string, unknown>)['@id'] as string;
		}
		if (first && typeof first === 'object' && '@value' in first) {
			return (first as Record<string, unknown>)['@value'] as string;
		}
	}
	if (value && typeof value === 'object' && '@id' in value) {
		return (value as Record<string, unknown>)['@id'] as string;
	}
	return undefined;
}

function normalizeToStringArray(value: unknown): string[] | undefined {
	if (!value) return undefined;
	const arr = Array.isArray(value) ? value : [value];
	const result: string[] = [];
	for (const item of arr) {
		const str = normalizeToString(item);
		if (str) result.push(str);
	}
	return result.length > 0 ? result : undefined;
}

function normalizeObjectValue(value: unknown): string | Record<string, unknown> | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return undefined;
		if (value.length === 1) return normalizeObjectValue(value[0]);
		return value as unknown as Record<string, unknown>;
	}
	if (value && typeof value === 'object') {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function extractLocalName(typeStr: string): string {
	const hashIdx = typeStr.lastIndexOf('#');
	if (hashIdx !== -1) return typeStr.slice(hashIdx + 1);
	const slashIdx = typeStr.lastIndexOf('/');
	if (slashIdx !== -1) return typeStr.slice(slashIdx + 1);
	return typeStr;
}

// ============================================================
// SETUP: Register all inbox listeners
// ============================================================

export function setupInboxListeners(
	federation: Federation<FedifyContextData>,
): void {
	federation
		.setInboxListeners('/users/{identifier}/inbox', '/inbox')

		// ── Follow ──────────────────────────────────────────────
		.on(Follow, async (ctx, follow) => {
			console.log('[inbox] Follow received from:', follow.actorId?.href);
			const { env } = ctx.data;

			if (await isActorDomainSuspended(follow.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Simple: extract directly from Fedify types
			const activity: APActivity = {
				type: 'Follow',
				id: follow.id?.href,
				actor: follow.actorId?.href ?? '',
				object: follow.objectId?.href,
			} as APActivity;

			await processFollow(activity, localAccountId, env);
		})

		// ── Create ──────────────────────────────────────────────
		.on(Create, async (ctx, create) => {
			console.log('[inbox] Create received from:', create.actorId?.href);
			const { env } = ctx.data;

			if (await isActorDomainSuspended(create.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Complex: need nested object, use JSON-LD
			const jsonLd = await create.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processCreate(activity, localAccountId, env);
		})

		// ── Accept ──────────────────────────────────────────────
		.on(Accept, async (ctx, accept) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(accept.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Accept needs object as string or nested object
			const jsonLd = await accept.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processAccept(activity, localAccountId, env);
		})

		// ── Reject ──────────────────────────────────────────────
		.on(Reject, async (ctx, reject) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(reject.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			const jsonLd = await reject.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processReject(activity, localAccountId, env);
		})

		// ── Like ────────────────────────────────────────────────
		.on(Like, async (ctx, like) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(like.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Need JSON-LD for Misskey extension detection
			const jsonLd = await like.toJsonLd();
			const raw = jsonLd as Record<string, unknown>;
			const activity = buildActivityFromJsonLd(raw);

			// Check for Misskey emoji reaction
			const isMisskeyReaction =
				(typeof raw._misskey_reaction === 'string' && raw._misskey_reaction !== '') ||
				(typeof raw.content === 'string' && raw.content !== '');

			if (isMisskeyReaction) {
				await processEmojiReact(
					activity as typeof activity & Record<string, unknown>,
					localAccountId,
					env,
				);
			} else {
				await processLike(activity, localAccountId, env);
			}
		})

		// ── Announce (Boost/Reblog) ─────────────────────────────
		.on(Announce, async (ctx, announce) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(announce.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Simple: extract directly from Fedify types
			const activity: APActivity = {
				type: 'Announce',
				id: announce.id?.href,
				actor: announce.actorId?.href ?? '',
				object: announce.objectId?.href,
			} as APActivity;

			await processAnnounce(activity, localAccountId, env);
		})

		// ── Delete ──────────────────────────────────────────────
		.on(Delete, async (ctx, del) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(del.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Delete needs object which can be string or nested
			const jsonLd = await del.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processDelete(activity, localAccountId, env);
		})

		// ── Update (Person or Note) ─────────────────────────────
		.on(Update, async (ctx, update) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(update.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Complex: needs nested object
			const jsonLd = await update.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processUpdate(activity, localAccountId, env);
		})

		// ── Undo (Follow, Like, Announce, Block) ────────────────
		.on(Undo, async (ctx, undo) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(undo.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Complex: nested inner activity
			const jsonLd = await undo.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processUndo(activity, localAccountId, env);
		})

		// ── Block ───────────────────────────────────────────────
		.on(Block, async (ctx, block) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(block.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Simple: extract directly
			const activity: APActivity = {
				type: 'Block',
				id: block.id?.href,
				actor: block.actorId?.href ?? '',
				object: block.objectId?.href,
			} as APActivity;

			await processBlock(activity, localAccountId, env);
		})

		// ── Move ────────────────────────────────────────────────
		.on(Move, async (ctx, move) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(move.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Move needs both object and target
			const jsonLd = await move.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processMove(activity, localAccountId, env);
		})

		// ── Flag (Report) ───────────────────────────────────────
		.on(Flag, async (ctx, flag) => {
			const { env } = ctx.data;

			if (flag.actorId) {
				const domain = extractDomain(flag.actorId.href);
				if (domain) {
					const blockResult = await isDomainBlocked(env.DB, env.CACHE, domain);
					if (blockResult.blocked || blockResult.rejectReports) {
						console.log(`[inbox] Dropping Flag from blocked/reject-reports domain: ${domain}`);
						return;
					}
				}
			}

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			// Flag has complex object (array of URIs)
			const jsonLd = await flag.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processFlag(activity, localAccountId, env);
		})

		// ── EmojiReact (native Fedify type) ─────────────────────
		.on(EmojiReact, async (ctx, emojiReact) => {
			const { env } = ctx.data;

			if (await isActorDomainSuspended(emojiReact.actorId, env)) return;

			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) return;

			const jsonLd = await emojiReact.toJsonLd();
			const activity = buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
			await processEmojiReact(
				activity as typeof activity & Record<string, unknown>,
				localAccountId,
				env,
			);
		})

		// ── Error handler ───────────────────────────────────────
		.onError((ctx, error) => {
			console.error('[inbox] Error processing activity:', error);
			console.error('[inbox] Error stack:', error instanceof Error ? error.stack : 'no stack');
		});
}
