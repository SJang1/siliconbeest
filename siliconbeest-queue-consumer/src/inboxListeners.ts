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

import type { FedifyContextData } from './fedify';
import type { Env } from './env';
import { adaptJsonLdToAPActivity } from '../../siliconbeest/server/worker/federation/helpers/activity-adapter';
import { isEmojiReaction } from '../../siliconbeest/server/worker/federation/helpers/misskey-compat';

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
// HELPER: Convert a Fedify activity to APActivity
// ============================================================

async function toAPActivity(activity: Activity) {
	const jsonLd = await activity.toJsonLd();
	return adaptJsonLdToAPActivity(jsonLd as Record<string, unknown>);
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
			const activity = await toAPActivity(follow);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			console.log('[inbox] Processing Follow for localAccountId:', localAccountId);
			await processFollow(activity, localAccountId, env as any);
			console.log('[inbox] Follow processed successfully');
		})

		// ── Create ──────────────────────────────────────────────
		.on(Create, async (ctx, create) => {
			console.log('[inbox] Create received from:', create.actorId?.href);
			const { env } = ctx.data;
			const activity = await toAPActivity(create);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			console.log('[inbox] Processing Create for localAccountId:', localAccountId, 'activity.object.type:', (activity as any).object?.type);
			await processCreate(activity, localAccountId, env as any);
			console.log('[inbox] Create processed successfully');
		})

		// ── Accept ──────────────────────────────────────────────
		.on(Accept, async (ctx, accept) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(accept);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processAccept(activity, localAccountId, env as any);
		})

		// ── Reject ──────────────────────────────────────────────
		.on(Reject, async (ctx, reject) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(reject);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processReject(activity, localAccountId, env as any);
		})

		// ── Like ────────────────────────────────────────────────
		.on(Like, async (ctx, like) => {
			const { env } = ctx.data;
			const jsonLd = await like.toJsonLd();
			const raw = jsonLd as Record<string, unknown>;
			const activity = adaptJsonLdToAPActivity(raw);
			const localAccountId = await resolveRecipientAccountId(ctx, env);

			if (isEmojiReaction(raw)) {
				await processEmojiReact(
					activity as typeof activity & Record<string, unknown>,
					localAccountId,
					env as any,
				);
			} else {
				await processLike(activity, localAccountId, env as any);
			}
		})

		// ── Announce (Boost/Reblog) ─────────────────────────────
		.on(Announce, async (ctx, announce) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(announce);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processAnnounce(activity, localAccountId, env as any);
		})

		// ── Delete ──────────────────────────────────────────────
		.on(Delete, async (ctx, del) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(del);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processDelete(activity, localAccountId, env as any);
		})

		// ── Update (Person or Note) ─────────────────────────────
		.on(Update, async (ctx, update) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(update);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processUpdate(activity, localAccountId, env as any);
		})

		// ── Undo (Follow, Like, Announce, Block) ────────────────
		.on(Undo, async (ctx, undo) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(undo);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processUndo(activity, localAccountId, env as any);
		})

		// ── Block ───────────────────────────────────────────────
		.on(Block, async (ctx, block) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(block);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processBlock(activity, localAccountId, env as any);
		})

		// ── Move ────────────────────────────────────────────────
		.on(Move, async (ctx, move) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(move);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processMove(activity, localAccountId, env as any);
		})

		// ── Flag (Report) ───────────────────────────────────────
		.on(Flag, async (ctx, flag) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(flag);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processFlag(activity, localAccountId, env as any);
		})

		// ── EmojiReact (native Fedify type) ─────────────────────
		.on(EmojiReact, async (ctx, emojiReact) => {
			const { env } = ctx.data;
			const activity = await toAPActivity(emojiReact);
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			await processEmojiReact(
				activity as typeof activity & Record<string, unknown>,
				localAccountId,
				env as any,
			);
		})

		// ── Error handler ───────────────────────────────────────
		.onError((ctx, error) => {
			console.error('[inbox] Error processing activity:', error);
			console.error('[inbox] Error stack:', error instanceof Error ? error.stack : 'no stack');
		});
}
