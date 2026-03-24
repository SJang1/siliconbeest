/**
 * Activity Builder
 *
 * Factory functions for constructing ActivityPub activity objects.
 * Each function generates a unique ID using ULID and wraps the
 * object in the appropriate activity envelope.
 */

import type { APActivity, APNote, APActor, APObject, APContext } from '../types/activitypub';
import { generateUlid } from '../utils/ulid';

const AP_CONTEXT: APContext = [
	'https://www.w3.org/ns/activitystreams',
	'https://w3id.org/security/v1',
];

/**
 * Extract the domain from an actor URI.
 */
function domainFromActor(actorUri: string): string {
	try {
		return new URL(actorUri).host;
	} catch {
		return 'unknown';
	}
}

/**
 * Generate a unique activity ID scoped to the actor's domain.
 */
function activityId(actorUri: string): string {
	const domain = domainFromActor(actorUri);
	return `https://${domain}/activities/${generateUlid()}`;
}

// ============================================================
// ACTIVITY BUILDERS
// ============================================================

/**
 * Build a Create activity wrapping a Note.
 */
export function buildCreateActivity(actor: string, object: APNote): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Create',
		actor,
		object,
		published: new Date().toISOString(),
		to: object.to,
		cc: object.cc,
	};
}

/**
 * Build a Follow activity targeting another actor.
 */
export function buildFollowActivity(actor: string, target: string): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Follow',
		actor,
		object: target,
	};
}

/**
 * Build an Accept activity in response to a Follow.
 */
export function buildAcceptActivity(actor: string, followActivity: APActivity): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Accept',
		actor,
		object: followActivity,
	};
}

/**
 * Build a Reject activity in response to a Follow.
 */
export function buildRejectActivity(actor: string, followActivity: APActivity): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Reject',
		actor,
		object: followActivity,
	};
}

/**
 * Build a Like activity for a given object URI.
 */
export function buildLikeActivity(actor: string, objectUri: string): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Like',
		actor,
		object: objectUri,
	};
}

/**
 * Build an Announce (boost/reblog) activity.
 */
export function buildAnnounceActivity(
	actor: string,
	objectUri: string,
	to: string[],
	cc: string[],
): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Announce',
		actor,
		object: objectUri,
		published: new Date().toISOString(),
		to,
		cc,
	};
}

/**
 * Build a Delete activity (Tombstone).
 */
export function buildDeleteActivity(actor: string, objectUri: string): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Delete',
		actor,
		object: {
			id: objectUri,
			type: 'Tombstone',
		},
		published: new Date().toISOString(),
	};
}

/**
 * Build an Update activity wrapping a Note or Actor.
 */
export function buildUpdateActivity(actor: string, object: APNote | APActor): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Update',
		actor,
		object: object as unknown as APObject,
		published: new Date().toISOString(),
		to: object.to,
		cc: object.cc,
	};
}

/**
 * Build an Undo activity wrapping a previously sent activity.
 */
export function buildUndoActivity(actor: string, originalActivity: APActivity): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Undo',
		actor,
		object: originalActivity,
	};
}

/**
 * Build a Flag (report) activity targeting an actor and optionally their statuses.
 * Per AP spec, the actor is typically the instance actor, not a user.
 */
export function buildFlagActivity(
	actorUri: string,
	targetUri: string,
	statusUris: string[],
	comment: string,
): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actorUri),
		type: 'Flag',
		actor: actorUri,
		object: [targetUri, ...statusUris],
		content: comment,
	};
}

/**
 * Build an EmojiReact activity (Misskey-compatible Like with _misskey_reaction).
 *
 * Uses the Like type with additional `content` and `_misskey_reaction` fields
 * so that Misskey, Pleroma, and Akkoma can display the emoji reaction.
 */
export function buildEmojiReactActivity(
	actor: string,
	objectUri: string,
	emoji: string,
): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Like',
		actor,
		object: objectUri,
		content: emoji,
		_misskey_reaction: emoji,
	} as APActivity;
}

/**
 * Build a Block activity targeting another actor.
 */
export function buildBlockActivity(actor: string, target: string): APActivity {
	return {
		'@context': AP_CONTEXT,
		id: activityId(actor),
		type: 'Block',
		actor,
		object: target,
	};
}
