/**
 * Fedify Inbox Listener Registration (Queue Consumer)
 *
 * This is a consumer-local copy of the worker's inbox listener setup.
 * The Fedify vocab types (Follow, Create, etc.) MUST be resolved from
 * the consumer's own node_modules to avoid the "dual package hazard"
 * where different class instances cause dispatchWithClass to fail.
 *
 * The inbox processor functions (plain business logic) are still imported
 * from the worker's source tree — they don't use Fedify vocab types.
 *
 * Activity conversion is done inline (no adapter layer) — simple activities
 * extract fields directly from Fedify types, complex ones use minimal
 * JSON-LD normalization.
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
import { measureAsync } from './observability/performance';

import type { FedifyContextData } from './fedify';
import type { Env } from './env';
import type { APActivity } from '../../siliconbeest/server/worker/types/activitypub';

// Import existing processors from the worker (plain functions, no Fedify types)
import { processFollow } from '../../siliconbeest/server/worker/federation/inboxProcessors/follow';
import { processCreate } from '../../siliconbeest/server/worker/federation/inboxProcessors/create';
import { processAccept } from '../../siliconbeest/server/worker/federation/inboxProcessors/accept';
import { processReject } from '../../siliconbeest/server/worker/federation/inboxProcessors/reject';
import { processLike } from '../../siliconbeest/server/worker/federation/inboxProcessors/like';
import { processAnnounce } from '../../siliconbeest/server/worker/federation/inboxProcessors/announce';
import { processDelete } from '../../siliconbeest/server/worker/federation/inboxProcessors/delete';
import { processUpdate } from '../../siliconbeest/server/worker/federation/inboxProcessors/update';
import { processUndo } from '../../siliconbeest/server/worker/federation/inboxProcessors/undo';
import { processBlock } from '../../siliconbeest/server/worker/federation/inboxProcessors/block';
import { processMove } from '../../siliconbeest/server/worker/federation/inboxProcessors/move';
import { processFlag } from '../../siliconbeest/server/worker/federation/inboxProcessors/flag';
import { processEmojiReact } from '../../siliconbeest/server/worker/federation/inboxProcessors/emojiReact';

// ============================================================
// HELPER: Resolve local account ID from inbox recipient
// ============================================================

async function resolveRecipientAccountId(
	ctx: InboxContext<FedifyContextData>,
	env: Env,
): Promise<string> {
	if (!ctx.recipient) {
		return '';
	}

	const username = ctx.recipient;

	const row = await env.DB.prepare(
		'SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1',
	)
		.bind(username)
		.first<{ id: string }>();

	if (!row) {
		console.warn(
			`[inbox] Could not resolve account for recipient: ${username}`,
		);
		return '';
	}

	return row.id;
}

// ============================================================
// HELPER: Build APActivity from JSON-LD (inline, no adapter)
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

	if (jsonLd.object !== undefined) activity.object = normalizeObjectValue(jsonLd.object);
	if (jsonLd.target !== undefined) activity.target = normalizeObjectValue(jsonLd.target);

	const to = normalizeToStringArray(jsonLd.to);
	if (to) activity.to = to;
	const cc = normalizeToStringArray(jsonLd.cc);
	if (cc) activity.cc = cc;

	if (typeof jsonLd.published === 'string') activity.published = jsonLd.published;
	if (typeof jsonLd.content === 'string') activity.content = jsonLd.content;
	if (jsonLd.signature) activity.signature = jsonLd.signature;
	if (jsonLd.proof) activity.proof = jsonLd.proof;
	if (jsonLd.tag) activity.tag = jsonLd.tag;

	for (const key of Object.keys(jsonLd)) {
		if (key.startsWith('_misskey_') || key === 'quoteUri') {
			activity[key] = jsonLd[key];
		}
	}

	return activity as unknown as APActivity;
}

async function toAPActivity(activity: Activity) {
	const jsonLd = await activity.toJsonLd();
	return buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
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
			await measureAsync(
				'inbox.Follow',
				async () => {
					console.log('[inbox] Follow received from:', follow.actorId?.href);
					const { env } = ctx.data;
					const activity: APActivity = {
						type: 'Follow',
						id: follow.id?.href,
						actor: follow.actorId?.href ?? '',
						object: follow.objectId?.href,
					} as APActivity;
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processFollow(activity, localAccountId, env as any);
				},
				{ actor: follow.actorId?.href }
			);
		})

		// ── Create ──────────────────────────────────────────────
		.on(Create, async (ctx, create) => {
			await measureAsync(
				'inbox.Create',
				async () => {
					console.log('[inbox] Create received from:', create.actorId?.href);
					const { env } = ctx.data;
					const activity = await toAPActivity(create);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processCreate(activity, localAccountId, env as any);
				},
				{ actor: create.actorId?.href }
			);
		})

		// ── Accept ──────────────────────────────────────────────
		.on(Accept, async (ctx, accept) => {
			await measureAsync(
				'inbox.Accept',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(accept);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processAccept(activity, localAccountId, env as any);
				},
				{ actor: accept.actorId?.href }
			);
		})

		// ── Reject ──────────────────────────────────────────────
		.on(Reject, async (ctx, reject) => {
			await measureAsync(
				'inbox.Reject',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(reject);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processReject(activity, localAccountId, env as any);
				},
				{ actor: reject.actorId?.href }
			);
		})

		// ── Like ────────────────────────────────────────────────
		.on(Like, async (ctx, like) => {
			await measureAsync(
				'inbox.Like',
				async () => {
					const { env } = ctx.data;
					const jsonLd = await like.toJsonLd();
					const raw = jsonLd as Record<string, unknown>;
					const activity = buildActivityFromJsonLd(raw);
					const localAccountId = await resolveRecipientAccountId(ctx, env);

					// Inline Misskey emoji reaction detection
					const isMisskeyReaction =
						(typeof raw._misskey_reaction === 'string' && raw._misskey_reaction !== '') ||
						(typeof raw.content === 'string' && raw.content !== '');

					if (isMisskeyReaction) {
						await processEmojiReact(
							activity as typeof activity & Record<string, unknown>,
							localAccountId,
							env as any,
						);
					} else {
						await processLike(activity, localAccountId, env as any);
					}
				},
				{ actor: like.actorId?.href }
			);
		})

		// ── Announce (Boost/Reblog) ─────────────────────────────
		.on(Announce, async (ctx, announce) => {
			await measureAsync(
				'inbox.Announce',
				async () => {
					const { env } = ctx.data;
					const activity: APActivity = {
						type: 'Announce',
						id: announce.id?.href,
						actor: announce.actorId?.href ?? '',
						object: announce.objectId?.href,
					} as APActivity;
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processAnnounce(activity, localAccountId, env as any);
				},
				{ actor: announce.actorId?.href }
			);
		})

		// ── Delete ──────────────────────────────────────────────
		.on(Delete, async (ctx, del) => {
			await measureAsync(
				'inbox.Delete',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(del);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processDelete(activity, localAccountId, env as any);
				},
				{ actor: del.actorId?.href }
			);
		})

		// ── Update (Person or Note) ─────────────────────────────
		.on(Update, async (ctx, update) => {
			await measureAsync(
				'inbox.Update',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(update);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processUpdate(activity, localAccountId, env as any);
				},
				{ actor: update.actorId?.href }
			);
		})

		// ── Undo (Follow, Like, Announce, Block) ────────────────
		.on(Undo, async (ctx, undo) => {
			await measureAsync(
				'inbox.Undo',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(undo);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processUndo(activity, localAccountId, env as any);
				},
				{ actor: undo.actorId?.href }
			);
		})

		// ── Block ───────────────────────────────────────────────
		.on(Block, async (ctx, block) => {
			await measureAsync(
				'inbox.Block',
				async () => {
					const { env } = ctx.data;
					const activity: APActivity = {
						type: 'Block',
						id: block.id?.href,
						actor: block.actorId?.href ?? '',
						object: block.objectId?.href,
					} as APActivity;
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processBlock(activity, localAccountId, env as any);
				},
				{ actor: block.actorId?.href }
			);
		})

		// ── Move ────────────────────────────────────────────────
		.on(Move, async (ctx, move) => {
			await measureAsync(
				'inbox.Move',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(move);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processMove(activity, localAccountId, env as any);
				},
				{ actor: move.actorId?.href }
			);
		})

		// ── Flag (Report) ───────────────────────────────────────
		.on(Flag, async (ctx, flag) => {
			await measureAsync(
				'inbox.Flag',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(flag);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processFlag(activity, localAccountId, env as any);
				},
				{ actor: flag.actorId?.href }
			);
		})

		// ── EmojiReact (native Fedify type) ─────────────────────
		.on(EmojiReact, async (ctx, emojiReact) => {
			await measureAsync(
				'inbox.EmojiReact',
				async () => {
					const { env } = ctx.data;
					const activity = await toAPActivity(emojiReact);
					const localAccountId = await resolveRecipientAccountId(ctx, env);
					await processEmojiReact(
						activity as typeof activity & Record<string, unknown>,
						localAccountId,
						env as any,
					);
				},
				{ actor: emojiReact.actorId?.href }
			);
		})

		// ── Error handler ───────────────────────────────────────
		.onError((ctx, error) => {
			console.error('[inbox] Error processing activity:', error);
			console.error('[inbox] Error stack:', error instanceof Error ? error.stack : 'no stack');
		});
}
