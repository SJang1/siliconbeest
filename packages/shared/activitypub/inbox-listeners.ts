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

import {
	extractDomain,
	getSuspendedDomains,
	isDomainBlocked,
} from '../domain-blocks';
import { buildActivityFromJsonLd } from './normalize';
import { pickSignerForRemote } from '../services/signer';
import { env } from 'cloudflare:workers';

// ============================================================
// STRUCTURAL TYPES (match Fedify's API without importing it)
// ============================================================

interface SenderKeyPairLike {
	readonly privateKey: CryptoKey;
	readonly keyId: URL;
}

interface RecipientLike {
	readonly id: URL | null;
	readonly inboxId: URL | null;
	readonly endpoints?: {
		readonly sharedInbox: URL | null;
	} | null;
}

interface ForwardActivityOptionsLike {
	readonly preferSharedInbox?: boolean;
	readonly immediate?: boolean;
	readonly normalizeExistingProofs?: boolean;
	readonly excludeBaseUris?: readonly URL[];
	readonly orderingKey?: string;
	readonly skipIfUnsigned: boolean;
}

type ForwarderLike =
	| SenderKeyPairLike
	| SenderKeyPairLike[]
	| { identifier: string }
	| { username: string };

interface ForwardActivityLike {
	(
		forwarder: ForwarderLike,
		recipients: RecipientLike | RecipientLike[],
		options?: ForwardActivityOptionsLike,
	): Promise<void>;
	(
		forwarder: { identifier: string } | { username: string },
		recipients: 'followers',
		options?: ForwardActivityOptionsLike,
	): Promise<void>;
}

/** Matches Fedify's InboxContext shape. */
interface InboxContextLike<TData> {
	recipient: string | null;
	data: TData;
	forwardActivity?: ForwardActivityLike;
}

/** Matches the builder returned by Federation.setInboxListeners(). */
interface InboxListenerBuilder<TData> {
	on(type: any, handler: (ctx: InboxContextLike<TData>, activity: any) => Promise<void>): InboxListenerBuilder<TData>;
	onError(handler: (ctx: any, error: Error) => void): void;
	setSharedKeyDispatcher(
		dispatcher: (ctx: any) => { identifier: string } | { username: string } | null | Promise<{ identifier: string } | { username: string } | null>,
	): InboxListenerBuilder<TData>;
	onUnverifiedActivity(
		handler: (ctx: any, activity: any, reason: any) => Response | undefined | void | Promise<Response | undefined | void>,
	): InboxListenerBuilder<TData>;
}

/** Matches Fedify's Federation shape (only the inbox listener API). */
interface FederationLike<TData> {
	setInboxListeners(path: string, sharedPath: string): InboxListenerBuilder<TData>;
}

type ProcessorFn = (activity: any, accountId: string) => Promise<void>;

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
	QuoteRequest: any;
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
	processQuoteRequest: ProcessorFn;
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
export function setupInboxListeners<TData>(
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
	): Promise<boolean> {
		if (!actorId) return false;
		const domain = extractDomain(actorId.href);
		if (!domain) return false;
		// Suspension is an immediate control-plane action.  Read D1 directly so
		// a stale or racing KV entry cannot briefly admit or reject activities.
		const suspendedDomains = await getSuspendedDomains(env.DB, [domain]);
		if (suspendedDomains.has(domain)) {
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
		afterProcess?: (
			ctx: InboxContextLike<TData>,
			activity: any,
			apActivity: Record<string, unknown>,
			localAccountId: string,
		) => Promise<void>,
	) {
		return async (ctx: InboxContextLike<TData>, activity: any) => {
			await withMeasure(name, activity.actorId?.href, async () => {
				if (await isActorDomainSuspended(activity.actorId)) return;

				const localAccountId = await resolveRecipientAccountId(ctx);
				if (localAccountId === null) return;

				const apActivity = await Promise.resolve(convert(activity));
				await processor(apActivity, localAccountId);
				if (afterProcess) {
					await afterProcess(ctx, activity, apActivity, localAccountId);
				}
			});
		};
	}

	function asArray(value: unknown): unknown[] {
		if (Array.isArray(value)) return value;
		if (value == null) return [];
		return [value];
	}

	function getStringId(value: unknown): string | null {
		if (!value) return null;
		if (typeof value === 'string') return value;
		if (typeof value === 'object') {
			const id = (value as Record<string, unknown>).id;
			return typeof id === 'string' ? id : null;
		}
		return null;
	}

	function collectReferencedStatusUris(value: unknown, out: Set<string>): void {
		if (!value) return;

		if (typeof value === 'string') {
			out.add(value);
			return;
		}

		if (Array.isArray(value)) {
			for (const item of value) collectReferencedStatusUris(item, out);
			return;
		}

		if (typeof value !== 'object') return;

		const object = value as Record<string, unknown>;
		for (const candidate of [
			getStringId(object.inReplyTo),
			getStringId(object.object),
			getStringId(object.target),
		]) {
			if (candidate) out.add(candidate);
		}

		collectReferencedStatusUris(object.object, out);
	}

	function isPubliclyAddressed(activity: Record<string, unknown>): boolean {
		const publicNs = 'https://www.w3.org/ns/activitystreams#Public';
		const recipients = [
			...asArray(activity.to),
			...asArray(activity.cc),
			...asArray((activity.object as Record<string, unknown> | undefined)?.to),
			...asArray((activity.object as Record<string, unknown> | undefined)?.cc),
		];
		return recipients.some((recipient) => recipient === publicNs);
	}

	async function forwardActivityForLocalStatus(
		ctx: InboxContextLike<TData>,
		apActivity: Record<string, unknown>,
	): Promise<void> {
		if (!ctx.forwardActivity) return;

		const referencedUris = new Set<string>();

		if (apActivity.type === 'Create') {
			collectReferencedStatusUris(apActivity.object, referencedUris);
			if (!isPubliclyAddressed(apActivity)) return;
		} else if (apActivity.type === 'Like' || apActivity.type === 'Announce') {
			collectReferencedStatusUris(apActivity.object, referencedUris);
		} else if (apActivity.type === 'Undo') {
			collectReferencedStatusUris(apActivity.object, referencedUris);
		} else {
			return;
		}

		if (referencedUris.size === 0) return;

		const placeholders = [...referencedUris].map(() => '?').join(',');
		const { results } = await env.DB.prepare(
			`SELECT DISTINCT a.username
			 FROM statuses s
			 JOIN accounts a ON a.id = s.account_id
			 WHERE s.uri IN (${placeholders})
			   AND s.local = 1
			   AND s.deleted_at IS NULL
			   AND s.visibility != 'direct'
			   AND a.domain IS NULL`,
		).bind(...referencedUris).all<{ username: string }>();

		for (const row of results ?? []) {
			try {
				await ctx.forwardActivity(
					{ identifier: row.username },
					'followers',
					{ skipIfUnsigned: true },
				);
				console.log(`[inbox] Forwarded ${apActivity.type} to followers of ${row.username}`);
			} catch (err) {
				console.error(`[inbox] Failed to forward ${apActivity.type} to followers of ${row.username}:`, err);
			}
		}
	}

	// ── Register listeners ────────────────────────────────────

	federation
		.setInboxListeners('/users/{identifier}/inbox', '/inbox')
		// Sign shared-inbox key-fetches with a real local account's key.
		// The shared `/inbox` has no per-request recipient, so we fall back
		// to `pickSignerUsername(db, null)` (oldest active local account).
		// We cannot use the `__instance__` identifier here because its actor
		// doc declares `id: /actor` while Fedify's route is
		// `/users/__instance__`, producing a keyId/publicKey.id mismatch
		// that authorized-fetch servers reject during verification.
		.setSharedKeyDispatcher(() => {
			// Shared inbox has no per-request recipient. Sign instance-wide
			// fetches (e.g., the keyId GET during inbound HTTP Signature
			// verification) with the instance actor's key. The instance
			// actor's `id` and `publicKey.id` are kept consistent with
			// Fedify's route (`/users/__instance__`) — see
			// `buildInstanceActor` and the `__instance__` row in actor_keys.
			return { identifier: '__instance__' };
		})

		.on(
			vocab.Follow,
			standardHandler('Follow', processors.processFollow, (f) =>
				buildSimple('Follow', f),
			),
		)
		.on(
			vocab.Create,
			standardHandler('Create', processors.processCreate, viaJsonLd, async (ctx, _activity, apActivity) => {
				await forwardActivityForLocalStatus(ctx, apActivity);
			}),
		)
		.on(
			vocab.Accept,
			standardHandler('Accept', processors.processAccept, viaJsonLd),
		)
		.on(
			vocab.Reject,
			standardHandler('Reject', processors.processReject, viaJsonLd),
		)
		.on(
			vocab.QuoteRequest,
			standardHandler('QuoteRequest', processors.processQuoteRequest, viaJsonLd),
		)

		// Like: special handling for Misskey emoji reactions
		.on(vocab.Like, async (ctx: InboxContextLike<TData>, like: any) => {
			await withMeasure('Like', like.actorId?.href, async () => {
				if (await isActorDomainSuspended(like.actorId)) return;

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
					);
				} else {
					await processors.processLike(
						activity,
						localAccountId,
					);
					await forwardActivityForLocalStatus(ctx, activity);
				}
			});
		})

		.on(
			vocab.Announce,
			standardHandler(
				'Announce',
				processors.processAnnounce,
				(a) => buildSimple('Announce', a),
				async (ctx, _activity, apActivity) => {
					await forwardActivityForLocalStatus(ctx, apActivity);
				},
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
			standardHandler('Undo', processors.processUndo, viaJsonLd, async (ctx, _activity, apActivity) => {
				await forwardActivityForLocalStatus(ctx, apActivity);
			}),
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
				if (flag.actorId) {
					const domain = extractDomain(flag.actorId.href);
					if (domain) {
						const suspendedDomains = await getSuspendedDomains(env.DB, [domain]);
						if (suspendedDomains.has(domain)) {
							console.log(
								`[inbox] Dropping Flag from suspended domain: ${domain}`,
							);
							return;
						}
						const blockResult = await isDomainBlocked(
							env.DB,
							env.CACHE,
							domain,
						);
						if (blockResult.rejectReports) {
							console.log(
								`[inbox] Dropping Flag from reject-reports domain: ${domain}`,
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

		.onUnverifiedActivity(async (_ctx: any, _activity: any, reason: any) => {
			// Diagnostic logging for signature-verification failures.
			// Captures the body of the response that failed the keyId fetch
			// so authorized-fetch / blocking decisions can be debugged.
			try {
				const type = reason?.type;
				const keyId = reason?.keyId?.href ?? reason?.result?.keyId?.href;
				if (type === 'keyFetchError') {
					const result = reason.result;
					if (result && 'status' in result && result.response) {
						let bodyPreview = '';
						try {
							bodyPreview = (await result.response.clone().text()).slice(0, 1024);
						} catch (bodyErr) {
							bodyPreview = `<failed to read body: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)}>`;
						}
						console.warn(
							`[inbox] keyFetchError keyId=${keyId} status=${result.status} body=${JSON.stringify(bodyPreview)}`,
						);
					} else if (result && 'error' in result) {
						console.warn(`[inbox] keyFetchError keyId=${keyId} error=${result.error?.message ?? result.error}`);
					} else {
						console.warn(`[inbox] keyFetchError keyId=${keyId} (no result detail)`);
					}
				} else {
					console.warn(`[inbox] unverified activity reason=${type} keyId=${keyId ?? 'n/a'}`);
				}
			} catch (logErr) {
				console.warn('[inbox] onUnverifiedActivity log failed:', logErr);
			}
			return undefined; // let Fedify return its default failed-signature response
		})
		.onError((_ctx: any, error: Error) => {
			console.error('[inbox] Error processing activity:', error);
			console.error(
				'[inbox] Error stack:',
				error instanceof Error ? error.stack : 'no stack',
			);
		});
}
