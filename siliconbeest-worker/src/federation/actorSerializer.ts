/**
 * Actor Serializer
 *
 * Converts local database rows into ActivityPub Actor JSON-LD documents.
 */

import type { APActor } from '../types/activitypub';
import type { AccountRow, ActorKeyRow } from '../types/db';

/**
 * Build a full ActivityPub Actor document from database rows.
 *
 * @param account - The account row from D1
 * @param actorKey - The actor key row containing the public key PEM
 * @param domain - The instance domain (e.g. "mastodon.social")
 * @returns A fully-formed APActor JSON-LD document
 */
export function serializeActor(
	account: AccountRow,
	actorKey: ActorKeyRow,
	domain: string,
): APActor {
	const actorUri = `https://${domain}/users/${account.username}`;
	const actorUrl = `https://${domain}/@${account.username}`;

	const actor: APActor = {
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			'https://w3id.org/security/v1',
		],
		id: actorUri,
		type: account.bot ? 'Service' : 'Person',
		preferredUsername: account.username,
		name: account.display_name || account.username,
		summary: account.note || null,
		url: actorUrl,
		inbox: `${actorUri}/inbox`,
		outbox: `${actorUri}/outbox`,
		followers: `${actorUri}/followers`,
		following: `${actorUri}/following`,
		featured: `${actorUri}/collections/featured`,
		featuredTags: `${actorUri}/collections/tags`,
		publicKey: {
			id: actorKey.key_id,
			owner: actorUri,
			publicKeyPem: actorKey.public_key,
		},
		endpoints: {
			sharedInbox: `https://${domain}/inbox`,
		},
		published: account.created_at,
		manuallyApprovesFollowers: account.manually_approves_followers === 1,
		discoverable: account.discoverable === 1,
	};

	// Icon (avatar)
	if (account.avatar_url && account.avatar_url !== '') {
		actor.icon = {
			type: 'Image',
			url: account.avatar_url,
			mediaType: 'image/png',
		};
	}

	// Image (header)
	if (account.header_url && account.header_url !== '') {
		actor.image = {
			type: 'Image',
			url: account.header_url,
			mediaType: 'image/png',
		};
	}

	// Moved account
	if (account.moved_to_account_id) {
		// movedTo is set externally when the target URI is resolved;
		// we omit it here since we only have the account ID.
	}

	return actor;
}
