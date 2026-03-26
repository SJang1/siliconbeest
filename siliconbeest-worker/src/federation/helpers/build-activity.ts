/**
 * Fedify-based Activity Builder
 *
 * Drop-in async replacement for the old `activityBuilder.ts`.
 * Uses Fedify vocab types for proper ActivityPub JSON-LD serialization,
 * then returns a JSON string ready for the existing delivery pipeline
 * (enqueueFanout / enqueueDelivery).
 *
 * Misskey vendor extensions (_misskey_reaction etc.) are injected
 * post-serialization via misskey-compat helpers.
 */

import {
	Accept,
	Announce,
	Block,
	Create,
	Delete as APDelete,
	Flag,
	Follow,
	Like,
	Move,
	Note,
	Reject,
	Tombstone,
	Undo,
	Update,
} from '@fedify/fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import { generateUlid } from '../../utils/ulid';
import { injectMisskeyReaction } from './misskey-compat';

// ============================================================
// HELPERS
// ============================================================

function activityIdUrl(actorUri: string): URL {
	const domain = new URL(actorUri).host;
	return new URL(`https://${domain}/activities/${generateUlid()}`);
}

/**
 * Serialize a Fedify activity to a JSON string for the delivery queue.
 */
async function toJsonString(activity: { toJsonLd(): Promise<unknown> }): Promise<string> {
	const jsonLd = await activity.toJsonLd();
	return JSON.stringify(jsonLd);
}

// ============================================================
// ACTIVITY BUILDERS — async replacements
// ============================================================

/**
 * Build a Create activity wrapping a Note.
 * The `noteJsonLdOrObject` can be either a pre-built JSON-LD object or raw note data.
 * For most uses, pass a plain APNote JSON object — it will be serialized as-is.
 */
export async function buildCreateActivity(actor: string, noteJsonLd: Record<string, unknown>): Promise<string> {
	// Wrap the existing note JSON in a Create envelope using Fedify
	const create = new Create({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		published: noteJsonLd.published ? Temporal.Instant.from(noteJsonLd.published as string) : Temporal.Now.instant(),
	});
	const createLd = (await create.toJsonLd()) as Record<string, unknown>;
	// Replace the Fedify-generated object with our fully-formed note
	createLd.object = noteJsonLd;
	// Copy addressing from the note
	if (noteJsonLd.to) createLd.to = noteJsonLd.to;
	if (noteJsonLd.cc) createLd.cc = noteJsonLd.cc;
	return JSON.stringify(createLd);
}

/**
 * Build a Follow activity targeting another actor.
 */
export async function buildFollowActivity(actor: string, target: string): Promise<string> {
	const follow = new Follow({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new URL(target),
	});
	return toJsonString(follow);
}

/**
 * Build an Accept activity in response to a Follow.
 */
export async function buildAcceptActivity(
	actor: string,
	followActivityJsonOrId: Record<string, unknown> | string,
	to?: string,
): Promise<string> {
	const accept = new Accept({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		tos: to ? [new URL(to)] : [],
	});
	const acceptLd = (await accept.toJsonLd()) as Record<string, unknown>;
	// Set the object to the original Follow activity or its ID
	acceptLd.object =
		typeof followActivityJsonOrId === 'string' ? followActivityJsonOrId : followActivityJsonOrId;
	return JSON.stringify(acceptLd);
}

/**
 * Build a Reject activity in response to a Follow.
 */
export async function buildRejectActivity(
	actor: string,
	followActivityJsonOrId: Record<string, unknown> | string,
	to?: string,
): Promise<string> {
	const reject = new Reject({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		tos: to ? [new URL(to)] : [],
	});
	const rejectLd = (await reject.toJsonLd()) as Record<string, unknown>;
	rejectLd.object =
		typeof followActivityJsonOrId === 'string' ? followActivityJsonOrId : followActivityJsonOrId;
	return JSON.stringify(rejectLd);
}

/**
 * Build a Like activity for a given object URI.
 */
export async function buildLikeActivity(actor: string, objectUri: string): Promise<string> {
	const like = new Like({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new URL(objectUri),
	});
	return toJsonString(like);
}

/**
 * Build an Announce (boost/reblog) activity.
 */
export async function buildAnnounceActivity(
	actor: string,
	objectUri: string,
	to: string[],
	cc: string[],
	published?: string,
): Promise<string> {
	const announce = new Announce({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new URL(objectUri),
		published: published ? Temporal.Instant.from(published) : Temporal.Now.instant(),
		tos: to.map((u) => new URL(u)),
		ccs: cc.map((u) => new URL(u)),
	});
	return toJsonString(announce);
}

/**
 * Build a Delete activity (Tombstone).
 */
export async function buildDeleteActivity(actor: string, objectUri: string): Promise<string> {
	const del = new APDelete({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new Tombstone({ id: new URL(objectUri) }),
		published: Temporal.Now.instant(),
	});
	return toJsonString(del);
}

/**
 * Build an Update activity wrapping a Note or Actor JSON-LD.
 */
export async function buildUpdateActivity(
	actor: string,
	objectJsonLd: Record<string, unknown>,
): Promise<string> {
	const update = new Update({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		published: Temporal.Now.instant(),
	});
	const updateLd = (await update.toJsonLd()) as Record<string, unknown>;
	updateLd.object = objectJsonLd;
	if (objectJsonLd.to) updateLd.to = objectJsonLd.to;
	if (objectJsonLd.cc) updateLd.cc = objectJsonLd.cc;
	return JSON.stringify(updateLd);
}

/**
 * Build an Undo activity wrapping a previously sent activity.
 */
export async function buildUndoActivity(
	actor: string,
	originalActivityJson: Record<string, unknown> | string,
): Promise<string> {
	const undo = new Undo({
		id: activityIdUrl(actor),
		actor: new URL(actor),
	});
	const undoLd = (await undo.toJsonLd()) as Record<string, unknown>;
	undoLd.object = originalActivityJson;
	return JSON.stringify(undoLd);
}

/**
 * Build a Flag (report) activity.
 */
export async function buildFlagActivity(
	actorUri: string,
	targetUri: string,
	statusUris: string[],
	comment: string,
): Promise<string> {
	const flag = new Flag({
		id: activityIdUrl(actorUri),
		actor: new URL(actorUri),
		objects: [new URL(targetUri), ...statusUris.map((u) => new URL(u))],
		content: comment,
	});
	return toJsonString(flag);
}

/**
 * Build an EmojiReact activity (Misskey-compatible Like with _misskey_reaction).
 */
export async function buildEmojiReactActivity(
	actor: string,
	objectUri: string,
	emoji: string,
): Promise<string> {
	const like = new Like({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new URL(objectUri),
	});
	const likeLd = (await like.toJsonLd()) as Record<string, unknown>;
	const withReaction = injectMisskeyReaction(likeLd, emoji);
	return JSON.stringify(withReaction);
}

/**
 * Build a Move activity indicating an account migration.
 */
export async function buildMoveActivity(actorUri: string, targetUri: string): Promise<string> {
	const move = new Move({
		id: new URL(`${actorUri}#moves/${generateUlid()}`),
		actor: new URL(actorUri),
		object: new URL(actorUri),
		target: new URL(targetUri),
	});
	return toJsonString(move);
}

/**
 * Build a Block activity targeting another actor.
 */
export async function buildBlockActivity(actor: string, target: string): Promise<string> {
	const block = new Block({
		id: activityIdUrl(actor),
		actor: new URL(actor),
		object: new URL(target),
	});
	return toJsonString(block);
}
