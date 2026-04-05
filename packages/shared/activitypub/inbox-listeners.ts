/**
 * Generic Inbox Listener Factory
 *
 * Single definition of all 13 ActivityPub inbox listeners, shared between
 * the main worker and queue consumer. Eliminates the ~400-line duplication
 * caused by the Fedify dual-package hazard.
 *
 * The dual-package hazard: Fedify's `.on(TypeClass, handler)` uses
 * `instanceof` checks internally, so the TypeClass MUST come from the
 * same `node_modules` as the Fedify instance. Since worker and consumer
 * are separate Cloudflare Workers with separate `node_modules`, we solve
 * this by having each caller pass their own Fedify vocab classes as
 * parameters — the shared code never imports `@fedify/vocab` directly.
 *
 * This module has ZERO external dependencies — no @fedify/fedify, no
 * @fedify/vocab. Fedify's API shape is expressed via structural types,
 * so TypeScript resolves everything from the caller's node_modules.
 */

import { isDomainBlocked, extractDomain } from '../domain-blocks';
import { buildActivityFromJsonLd } from './normalize';

// ============================================================
// STRUCTURAL TYPES (match Fedify's API without importing it)
// ============================================================

/** Matches Fedify's InboxContext shape. */
interface InboxContextLike<TData> {
	recipient: string | null;
	data: TData;
}

/** Matches the builder returned by Federation.setInboxListeners(). */
interface InboxListenerBuilder<TData> {
	on(type: any, handler: (ctx: InboxContextLike<TData>, activity: any) => Promise<void>): InboxListenerBuilder<TData>;
	onError(handler: (ctx: any, error: Error) => void): void;
}

/** Matches Fedify's Federation shape (only the inbox listener API). */
interface FederationLike<TData> {
	setInboxListeners(path: string, sharedPath: string): InboxListenerBuilder<TData>;
}

/** Minimal env shape required by inbox processing. Both worker and consumer Env satisfy this. */
interface InboxEnv {
	DB: D1Database;
	CACHE: KVNamespace;
}

type ProcessorFn = (activity: any, accountId: string, env: any) => Promise<void>;

/** Fedify vocab activity classes — each caller passes their own to avoid dual-package hazard. */
export interface InboxListenerVocab {
	Follow: any;
	Create: any;
	Like: any;
	Announce: any;
	Delete: any;
	Update: any;
	Undo: any;
	Block: any;
	Flag: any;
	Move: any;
	Accept: any;
	Reject: any;
	EmojiReact: any;
}

/** Inbox processor functions — plain business logic with no Fedify dependency. */
export interface InboxListenerProcessors {
	processFollow: ProcessorFn;
	processCreate: ProcessorFn;
	processAccept: ProcessorFn;
	processReject: ProcessorFn;
	processLike: ProcessorFn;
	processAnnounce: ProcessorFn;
	processDelete: ProcessorFn;
	processUpdate: ProcessorFn;
	processUndo: ProcessorFn;
	processBlock: ProcessorFn;
	processMove: ProcessorFn;
	processFlag: ProcessorFn;
	processEmojiReact: ProcessorFn;
}

export interface InboxListenerOptions {
	/** Optional performance measurement wrapper. When provided, wraps each handler. */
	measure?: <T>(
		name: string,
		fn: () => Promise<T>,
		meta?: Record<string, any>,
	) => Promise<T>;
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Register all 13 inbox listeners on a Fedify federation instance.
 *
 * @param federation - Fedify Federation instance (from caller's node_modules)
 * @param vocab - Fedify vocab classes (from caller's node_modules)
 * @param processors - Inbox processor functions
 * @param options - Optional configuration (performance measurement)
 */
export function setupInboxListeners<
	TData extends { env: InboxEnv },
>(
	federation: FederationLike<TData>,
	vocab: InboxListenerVocab,
	processors: InboxListenerProcessors,
	options?: InboxListenerOptions,
): void {
	const { measure } = options ?? {};

	// ── Helpers ────────────────────────────────────────────────

	async function resolveRecipientAccountId(
		ctx: InboxContextLike<TData>,
	): Promise<string | null> {
		if (!ctx.recipient) return ''; // Shared inbox
		const { env } = ctx.data;
		const row = await env.DB.prepare(
			'SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1',
		)
			.bind(ctx.recipient)
			.first<{ id: string }>();
		if (!row) {
			console.warn(
				`[inbox] Could not resolve account for recipient: ${ctx.recipient}`,
			);
			return null;
		}
		return row.id;
	}

	async function isActorDomainSuspended(
		actorId: URL | null,
		env: InboxEnv,
	): Promise<boolean> {
		if (!actorId) return false;
		const domain = extractDomain(actorId.href);
		if (!domain) return false;
		const result = await isDomainBlocked(env.DB, env.CACHE, domain);
		if (result.blocked) {
			console.log(
				`[inbox] Dropping activity from suspended domain: ${domain}`,
			);
			return true;
		}
		return false;
	}

	async function withMeasure(
		name: string,
		actorHref: string | undefined,
		fn: () => Promise<void>,
	): Promise<void> {
		if (measure) {
			await measure(`inbox.${name}`, fn, { actor: actorHref });
		} else {
			console.log(`[inbox] ${name} received from:`, actorHref);
			await fn();
		}
	}

	/** Build a simple APActivity from direct Fedify field extraction. */
	function buildSimple(
		type: string,
		activity: any,
	): Record<string, unknown> {
		return {
			type,
			id: activity.id?.href,
			actor: activity.actorId?.href ?? '',
			object: activity.objectId?.href,
		};
	}

	/** Convert a Fedify activity to a plain object via JSON-LD serialization. */
	async function viaJsonLd(activity: any): Promise<Record<string, unknown>> {
		const jsonLd = await activity.toJsonLd();
		return buildActivityFromJsonLd(jsonLd as Record<string, unknown>);
	}

	/**
	 * Create a standard handler: domain block check -> resolve recipient -> convert -> process.
	 * Covers the common pattern used by most activity types.
	 */
	function standardHandler(
		name: string,
		processor: ProcessorFn,
		convert: (
			activity: any,
		) => Record<string, unknown> | Promise<Record<string, unknown>>,
	) {
		return async (ctx: InboxContextLike<TData>, activity: any) => {
			await withMeasure(name, activity.actorId?.href, async () => {
				const { env } = ctx.data;
				if (await isActorDomainSuspended(activity.actorId, env)) return;

				const localAccountId = await resolveRecipientAccountId(ctx);
				if (localAccountId === null) return;

				const apActivity = await Promise.resolve(convert(activity));
				await processor(apActivity, localAccountId, env);
			});
		};
	}

	// ── Register listeners ────────────────────────────────────

	federation
		.setInboxListeners('/users/{identifier}/inbox', '/inbox')

		.on(
			vocab.Follow,
			standardHandler('Follow', processors.processFollow, (f) =>
				buildSimple('Follow', f),
			),
		)
		.on(
			vocab.Create,
			standardHandler('Create', processors.processCreate, viaJsonLd),
		)
		.on(
			vocab.Accept,
			standardHandler('Accept', processors.processAccept, viaJsonLd),
		)
		.on(
			vocab.Reject,
			standardHandler('Reject', processors.processReject, viaJsonLd),
		)

		// Like: special handling for Misskey emoji reactions
		.on(vocab.Like, async (ctx: InboxContextLike<TData>, like: any) => {
			await withMeasure('Like', like.actorId?.href, async () => {
				const { env } = ctx.data;
				if (await isActorDomainSuspended(like.actorId, env)) return;

				const localAccountId = await resolveRecipientAccountId(ctx);
				if (localAccountId === null) return;

				const jsonLd = await like.toJsonLd();
				const raw = jsonLd as Record<string, unknown>;
				const activity = buildActivityFromJsonLd(raw);

				const isMisskeyReaction =
					(typeof raw._misskey_reaction === 'string' &&
						raw._misskey_reaction !== '') ||
					(typeof raw.content === 'string' && raw.content !== '');

				if (isMisskeyReaction) {
					await processors.processEmojiReact(
						activity,
						localAccountId,
						env,
					);
				} else {
					await processors.processLike(
						activity,
						localAccountId,
						env,
					);
				}
			});
		})

		.on(
			vocab.Announce,
			standardHandler('Announce', processors.processAnnounce, (a) =>
				buildSimple('Announce', a),
			),
		)
		.on(
			vocab.Delete,
			standardHandler('Delete', processors.processDelete, viaJsonLd),
		)
		.on(
			vocab.Update,
			standardHandler('Update', processors.processUpdate, viaJsonLd),
		)
		.on(
			vocab.Undo,
			standardHandler('Undo', processors.processUndo, viaJsonLd),
		)
		.on(
			vocab.Block,
			standardHandler('Block', processors.processBlock, (b) =>
				buildSimple('Block', b),
			),
		)
		.on(
			vocab.Move,
			standardHandler('Move', processors.processMove, viaJsonLd),
		)

		// Flag: special domain block handling (also checks rejectReports)
		.on(vocab.Flag, async (ctx: InboxContextLike<TData>, flag: any) => {
			await withMeasure('Flag', flag.actorId?.href, async () => {
				const { env } = ctx.data;

				if (flag.actorId) {
					const domain = extractDomain(flag.actorId.href);
					if (domain) {
						const blockResult = await isDomainBlocked(
							env.DB,
							env.CACHE,
							domain,
						);
						if (blockResult.blocked || blockResult.rejectReports) {
							console.log(
								`[inbox] Dropping Flag from blocked/reject-reports domain: ${domain}`,
							);
							return;
						}
					}
				}

				const localAccountId = await resolveRecipientAccountId(ctx);
				if (localAccountId === null) return;

				const activity = await viaJsonLd(flag);
				await processors.processFlag(
					activity,
					localAccountId,
					env,
				);
			});
		})

		.on(
			vocab.EmojiReact,
			standardHandler(
				'EmojiReact',
				processors.processEmojiReact,
				viaJsonLd,
			),
		)

		.onError((_ctx: any, error: Error) => {
			console.error('[inbox] Error processing activity:', error);
			console.error(
				'[inbox] Error stack:',
				error instanceof Error ? error.stack : 'no stack',
			);
		});
}
