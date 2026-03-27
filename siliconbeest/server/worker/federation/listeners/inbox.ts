/**
 * Fedify Inbox Listener Registration
 *
 * Wires up Fedify's `setInboxListeners` to call the existing 13 inbox
 * processors. Each listener:
 *   1. Receives a Fedify-typed activity (after Fedify has verified signatures)
 *   2. Converts it to the APActivity format via `adaptJsonLdToAPActivity`
 *   3. Resolves the local account ID from the inbox recipient identifier
 *   4. Calls the corresponding processor
 *
 * This file is created as part of Phase 2 (Fedify listener registration).
 * It will NOT be imported/used until Phase 3 wires it up in index.ts.
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
import type { FedifyContextData } from '../fedify';
import { adaptJsonLdToAPActivity } from '../helpers/activity-adapter';
import { isEmojiReaction } from '../helpers/misskey-compat';

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

/**
 * Resolve the local account ID from the Fedify inbox context.
 *
 * For personal inboxes, `ctx.recipient` is the `{identifier}` extracted
 * from the path pattern `/users/{identifier}/inbox`. We look up the
 * corresponding account_id from the accounts table.
 *
 * For the shared inbox, `ctx.recipient` is `null` and we return an
 * empty string (matching the existing convention in processInboxActivity).
 *
 * Returns `null` if the recipient does not exist, allowing early exit
 * before expensive JSON-LD parsing.
 */
async function resolveRecipientAccountId(
	ctx: InboxContext<FedifyContextData>,
	env: Env,
): Promise<string | null> {
	if (!ctx.recipient) {
		// Shared inbox — no specific recipient
		return '';
	}

	// ctx.recipient is the {identifier} from /users/{identifier}/inbox
	// which is the username of the local account
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
		return null; // Explicitly return null when NOT FOUND
	}

	return row.id;
}

// ============================================================
// HELPER: Convert a Fedify activity to APActivity
// ============================================================

/**
 * Convert a Fedify typed activity to the APActivity format expected by
 * the existing inbox processors.
 */
async function toAPActivity(activity: Activity) {
	const jsonLd = await activity.toJsonLd();
	return adaptJsonLdToAPActivity(jsonLd as Record<string, unknown>);
}

// ============================================================
// SETUP: Register all inbox listeners
// ============================================================

/**
 * Register Fedify inbox listeners for all 13 activity types.
 *
 * This sets up the personal inbox at `/users/{identifier}/inbox` and
 * the shared inbox at `/inbox`. Fedify handles HTTP signature verification
 * before calling these listeners.
 */
export function setupInboxListeners(
	federation: Federation<FedifyContextData>,
): void {
	federation
		.setInboxListeners('/users/{identifier}/inbox', '/inbox')

		// ── Follow ──────────────────────────────────────────────
		.on(Follow, async (ctx, follow) => {
			console.log('[inbox] Follow received from:', follow.actorId?.href);
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Follow activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(follow);
			console.log('[inbox] Processing Follow for localAccountId:', localAccountId);
			await processFollow(activity, localAccountId, env);
			console.log('[inbox] Follow processed successfully');
		})

		// ── Create ──────────────────────────────────────────────
		.on(Create, async (ctx, create) => {
			console.log('[inbox] Create received from:', create.actorId?.href);
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Create activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(create);
			console.log('[inbox] Processing Create for localAccountId:', localAccountId, 'activity.object.type:', (activity as any).object?.type);
			await processCreate(activity, localAccountId, env);
			console.log('[inbox] Create processed successfully');
		})

		// ── Accept ──────────────────────────────────────────────
		.on(Accept, async (ctx, accept) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Accept activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(accept);
			await processAccept(activity, localAccountId, env);
		})

		// ── Reject ──────────────────────────────────────────────
		.on(Reject, async (ctx, reject) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Reject activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(reject);
			await processReject(activity, localAccountId, env);
		})

		// ── Like ────────────────────────────────────────────────
		// Misskey sends emoji reactions as Like activities with
		// _misskey_reaction or content fields. We check after
		// converting to JSON-LD/APActivity format.
		.on(Like, async (ctx, like) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Like activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const jsonLd = await like.toJsonLd();
			const raw = jsonLd as Record<string, unknown>;
			const activity = adaptJsonLdToAPActivity(raw);

			if (isEmojiReaction(raw)) {
				// Misskey-style emoji reaction disguised as a Like
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
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Announce activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(announce);
			await processAnnounce(activity, localAccountId, env);
		})

		// ── Delete ──────────────────────────────────────────────
		.on(Delete, async (ctx, del) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Delete activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(del);
			await processDelete(activity, localAccountId, env);
		})

		// ── Update (Person or Note) ─────────────────────────────
		.on(Update, async (ctx, update) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Update activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(update);
			await processUpdate(activity, localAccountId, env);
		})

		// ── Undo (Follow, Like, Announce, Block) ────────────────
		.on(Undo, async (ctx, undo) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Undo activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(undo);
			await processUndo(activity, localAccountId, env);
		})

		// ── Block ───────────────────────────────────────────────
		.on(Block, async (ctx, block) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Block activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(block);
			await processBlock(activity, localAccountId, env);
		})

		// ── Move ────────────────────────────────────────────────
		.on(Move, async (ctx, move) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Move activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(move);
			await processMove(activity, localAccountId, env);
		})

		// ── Flag (Report) ───────────────────────────────────────
		.on(Flag, async (ctx, flag) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping Flag activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(flag);
			await processFlag(activity, localAccountId, env);
		})

		// ── EmojiReact (native Fedify type) ─────────────────────
		.on(EmojiReact, async (ctx, emojiReact) => {
			const { env } = ctx.data;
			
			// CHEAP DB LOOKUP FIRST
			const localAccountId = await resolveRecipientAccountId(ctx, env);
			if (localAccountId === null) {
				console.warn('[inbox] Dropping EmojiReact activity: Recipient not found');
				return;
			}
			
			// EXPENSIVE WORK ONLY IF RECIPIENT EXISTS
			const activity = await toAPActivity(emojiReact);
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
