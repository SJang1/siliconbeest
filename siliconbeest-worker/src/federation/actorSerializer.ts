/**
 * Actor Serializer
 *
 * Converts local database rows into ActivityPub Actor JSON-LD documents.
 */

import type { APActor, APPropertyValue, APTag } from '../types/activitypub';
import type { AccountRow, ActorKeyRow, CustomEmojiRow } from '../types/db';
import { encodeEd25519PublicKeyMultibase } from '../utils/crypto';

/** Profile metadata field as stored in the accounts.fields JSON column. */
interface ProfileField {
	name: string;
	value: string;
	verified_at?: string | null;
}

/**
 * Build a full ActivityPub Actor document from database rows.
 *
 * @param account - The account row from D1
 * @param actorKey - The actor key row containing the public key PEM
 * @param domain - The instance domain (e.g. "mastodon.social")
 * @param opts - Optional extra data for the actor document
 * @returns A fully-formed APActor JSON-LD document
 */
export function serializeActor(
	account: AccountRow,
	actorKey: ActorKeyRow,
	domain: string,
	opts?: { alsoKnownAs?: string[]; customEmojis?: CustomEmojiRow[] },
): APActor {
	const actorUri = `https://${domain}/users/${account.username}`;
	const actorUrl = `https://${domain}/@${account.username}`;

	const actor: APActor = {
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			'https://w3id.org/security/v1',
			'https://w3id.org/security/data-integrity/v1',
			{
				'toot': 'http://joinmastodon.org/ns#',
				'Emoji': 'toot:Emoji',
				'schema': 'http://schema.org#',
				'PropertyValue': 'schema:PropertyValue',
				'value': 'schema:value',
				'Multikey': 'https://w3id.org/security#Multikey',
				'publicKeyMultibase': 'https://w3id.org/security#publicKeyMultibase',
				'assertionMethod': {
					'@id': 'https://w3id.org/security#assertionMethod',
					'@type': '@id',
					'@container': '@set',
				},
			},
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
		assertionMethod: actorKey.ed25519_public_key
			? [{
				id: `${actorUri}#ed25519-key`,
				type: 'Multikey',
				controller: actorUri,
				publicKeyMultibase: encodeEd25519PublicKeyMultibase(actorKey.ed25519_public_key),
			}]
			: undefined,
		endpoints: {
			sharedInbox: `https://${domain}/inbox`,
		},
		published: account.created_at,
		manuallyApprovesFollowers: account.manually_approves_followers === 1,
		discoverable: account.discoverable === 1,
		alsoKnownAs: opts?.alsoKnownAs ?? [],
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

	// Profile metadata fields (PropertyValue attachments)
	const fieldsJson = (account as unknown as Record<string, unknown>).fields as string | null | undefined;
	if (fieldsJson) {
		try {
			const fields: ProfileField[] = JSON.parse(fieldsJson);
			if (Array.isArray(fields) && fields.length > 0) {
				actor.attachment = fields.map((f): APPropertyValue => ({
					type: 'PropertyValue',
					name: f.name,
					value: f.value,
				}));
			}
		} catch {
			// Invalid JSON in fields column; skip
		}
	}

	// Custom emoji tags (for emojis used in display name or bio)
	if (opts?.customEmojis && opts.customEmojis.length > 0) {
		actor.tag = opts.customEmojis.map((emoji): APTag => ({
			type: 'Emoji',
			name: `:${emoji.shortcode}:`,
			icon: {
				type: 'Image',
				url: emoji.image_key,
				mediaType: 'image/png',
			},
		}));
	}

	// Moved account
	if (account.moved_to_account_id) {
		// movedTo is set externally when the target URI is resolved;
		// we omit it here since we only have the account ID.
	}

	return actor;
}
