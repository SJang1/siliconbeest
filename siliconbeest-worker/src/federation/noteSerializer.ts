/**
 * Note Serializer
 *
 * Converts local status rows into ActivityPub Note objects.
 */

import type { APNote, APTag, APDocument } from '../types/activitypub';
import type { StatusRow, AccountRow, MentionRow, TagRow } from '../types/db';

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

export interface SerializeNoteOptions {
	/** Mention rows associated with this status */
	mentions?: MentionRow[];
	/** Tag rows associated with this status */
	tags?: TagRow[];
	/** Media attachment info for the status */
	attachments?: {
		url: string;
		mediaType: string;
		description: string;
		width?: number | null;
		height?: number | null;
		blurhash?: string | null;
		type: string;
	}[];
}

/**
 * Build an ActivityPub Note object from database rows.
 *
 * @param status - The status row from D1
 * @param account - The account row of the status author
 * @param domain - The instance domain
 * @param opts - Optional mentions, tags, and attachments
 * @returns A fully-formed APNote object
 */
export function serializeNote(
	status: StatusRow,
	account: AccountRow,
	domain: string,
	opts?: SerializeNoteOptions,
): APNote {
	const actorUri = `https://${domain}/users/${account.username}`;
	const followersUri = `${actorUri}/followers`;

	// Determine to/cc based on visibility
	const { to, cc } = resolveAddressing(status.visibility, followersUri, opts?.mentions);

	// Build tag array
	const apTags: APTag[] = [];

	if (opts?.mentions) {
		for (const mention of opts.mentions) {
			// For mentions we need the account URI; use a placeholder pattern
			// that matches the account_id. In practice the caller resolves URIs.
			apTags.push({
				type: 'Mention',
				href: mention.account_id, // Caller should resolve to full actor URI
				name: `@${mention.account_id}`,
			});
		}
	}

	if (opts?.tags) {
		for (const tag of opts.tags) {
			apTags.push({
				type: 'Hashtag',
				href: `https://${domain}/tags/${tag.name}`,
				name: `#${tag.name}`,
			});
		}
	}

	// Build attachment array
	const apAttachments: APDocument[] = [];
	if (opts?.attachments) {
		for (const att of opts.attachments) {
			const docType = mapMediaType(att.type);
			const doc: APDocument = {
				type: docType,
				mediaType: att.mediaType,
				url: att.url,
				name: att.description || null,
			};
			if (att.width != null) doc.width = att.width;
			if (att.height != null) doc.height = att.height;
			if (att.blurhash) doc.blurhash = att.blurhash;
			apAttachments.push(doc);
		}
	}

	const note: APNote = {
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			'https://w3id.org/security/v1',
		],
		id: status.uri,
		type: 'Note',
		attributedTo: actorUri,
		content: status.content,
		url: status.url ?? `https://${domain}/@${account.username}/${status.id}`,
		published: status.created_at,
		to,
		cc,
		sensitive: status.sensitive === 1,
		summary: status.content_warning || null,
		inReplyTo: null, // Caller sets this from the reply chain
	};

	if (status.in_reply_to_id) {
		// The caller should resolve the full URI of the parent status.
		// We set the raw value so the caller can override.
		note.inReplyTo = status.in_reply_to_id;
	}

	if (status.conversation_id) {
		note.conversation = status.conversation_id;
	}

	if (apTags.length > 0) {
		note.tag = apTags;
	}

	if (apAttachments.length > 0) {
		note.attachment = apAttachments;
	}

	if (status.edited_at) {
		note.updated = status.edited_at;
	}

	if (status.language) {
		note.contentMap = { [status.language]: status.content };
	}

	// Include source for editable text
	if (status.text) {
		note.source = {
			content: status.text,
			mediaType: 'text/plain',
		};
	}

	return note;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Determine the to/cc arrays based on Mastodon-style visibility.
 */
function resolveAddressing(
	visibility: string,
	followersUri: string,
	mentions?: MentionRow[],
): { to: string[]; cc: string[] } {
	// Collect mentioned account IDs (caller should map these to actor URIs)
	const mentionUris = mentions?.map((m) => m.account_id) ?? [];

	switch (visibility) {
		case 'public':
			return {
				to: [AS_PUBLIC],
				cc: [followersUri, ...mentionUris],
			};

		case 'unlisted':
			return {
				to: [followersUri],
				cc: [AS_PUBLIC, ...mentionUris],
			};

		case 'private':
			return {
				to: [followersUri],
				cc: mentionUris,
			};

		case 'direct':
			return {
				to: mentionUris,
				cc: [],
			};

		default:
			// Default to public addressing
			return {
				to: [AS_PUBLIC],
				cc: [followersUri, ...mentionUris],
			};
	}
}

/**
 * Map internal media type strings to AP Document types.
 */
function mapMediaType(type: string): 'Document' | 'Image' | 'Audio' | 'Video' {
	switch (type) {
		case 'image':
			return 'Image';
		case 'video':
			return 'Video';
		case 'audio':
			return 'Audio';
		default:
			return 'Document';
	}
}
