/**
 * Activity Builder
 *
 * Factory functions for constructing ActivityPub activity objects.
 * Each function generates a unique ID using ULID and wraps the
 * object in the appropriate activity envelope.
 */

import type { APActivity, APNote, APActor, APContext } from '../types/activitypub';
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
		object,
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
