/**
 * Shared helpers for collection dispatchers and object dispatchers.
 *
 * Extracted from the monolithic collections.ts (originally ~200 lines of helpers
 * at the bottom of an 861-line file). These are used by both collection
 * dispatchers and the Note/activity object dispatchers.
 */

import {
  Note,
  Image,
  Document as APDocument,
  Source,
  Emoji as APEmoji,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { AccountRow, StatusRow } from '../../../types/db';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * Convert an ISO 8601 date string to a Temporal.Instant.
 */
export function toTemporalInstant(isoString: string): Temporal.Instant {
  return Temporal.Instant.from(isoString);
}

/**
 * Map internal media type string to Fedify vocabulary class constructor.
 */
export function buildMediaAttachment(
  att: {
    url: string;
    mediaType: string;
    description: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    type: string;
  },
): Image | APDocument {
  const values: Record<string, unknown> = {
    url: new URL(att.url),
    mediaType: att.mediaType,
    name: att.description || null,
  };

  if (att.type === 'image') {
    if (att.width != null) values.width = att.width;
    if (att.height != null) values.height = att.height;
    return new Image(values as ConstructorParameters<typeof Image>[0]);
  }

  return new APDocument(
    values as ConstructorParameters<typeof APDocument>[0],
  );
}

/** Result from building a Fedify Note with addressing info. */
export interface FedifyNoteResult {
  note: Note;
  tos: URL[];
  ccs: URL[];
}

/**
 * Build a Fedify Note from a StatusRow, matching the logic in noteSerializer.ts.
 * Returns the Note plus the to/cc URL arrays for the wrapping activity.
 */
export function buildFedifyNote(
  status: StatusRow,
  account: AccountRow,
  domain: string,
  helpers: {
    convMap: Map<string, string | null>;
    mediaMap: Map<
      string,
      {
        url: string;
        mediaType: string;
        description: string;
        width: number | null;
        height: number | null;
        blurhash: string | null;
        type: string;
      }[]
    >;
    replyUriMap: Map<string, string>;
  },
): FedifyNoteResult {
  const actorUri = `https://${domain}/users/${account.username}`;
  const followersUri = `${actorUri}/followers`;

  // Determine to/cc based on visibility
  const { tos, ccs } = resolveAddressing(status.visibility, followersUri);

  // Determine inReplyTo
  let replyTarget: URL | null = null;
  if (status.in_reply_to_id) {
    if (status.in_reply_to_id.startsWith('http')) {
      replyTarget = new URL(status.in_reply_to_id);
    } else {
      const resolvedUri = helpers.replyUriMap.get(status.in_reply_to_id);
      if (resolvedUri) {
        replyTarget = new URL(resolvedUri);
      } else {
        replyTarget = new URL(
          `https://${domain}/users/${account.username}/statuses/${status.in_reply_to_id}`,
        );
      }
    }
  }

  // Build attachments
  const attachments = (helpers.mediaMap.get(status.id) ?? []).map(
    buildMediaAttachment,
  );

  // Build Note values
  const noteValues: ConstructorParameters<typeof Note>[0] = {
    id: new URL(status.uri),
    attribution: new URL(actorUri),
    content: status.content,
    url: new URL(
      status.url ?? `https://${domain}/@${account.username}/${status.id}`,
    ),
    published: toTemporalInstant(status.created_at),
    tos: tos.map((u) => u),
    ccs: ccs.map((u) => u),
    sensitive: status.sensitive === 1,
    summary: status.content_warning || null,
  };

  if (replyTarget) {
    noteValues.replyTarget = replyTarget;
  }

  if (attachments.length > 0) {
    noteValues.attachments = attachments;
  }

  if (status.edited_at) {
    noteValues.updated = toTemporalInstant(status.edited_at);
  }

  if (status.text) {
    noteValues.source = new Source({
      content: status.text,
      mediaType: 'text/plain',
    });
  }

  // Build custom emoji tags from emoji_tags JSON
  const emojiTagObjects: APEmoji[] = [];
  if ((status as any).emoji_tags) {
    try {
      const emojiTags = JSON.parse((status as any).emoji_tags) as Array<{ shortcode: string; url: string; static_url?: string }>;
      for (const et of emojiTags) {
        if (!et.shortcode || !et.url) continue;
        emojiTagObjects.push(new APEmoji({
          id: new URL(et.url),
          name: `:${et.shortcode}:`,
          icon: new Image({ url: new URL(et.url), mediaType: 'image/png' }),
        }));
      }
    } catch { /* ignore malformed JSON */ }
  }

  if (emojiTagObjects.length > 0) {
    noteValues.tags = [...(noteValues.tags ?? []), ...emojiTagObjects];
  }

  const note = new Note(noteValues);

  return { note, tos, ccs };
}

/**
 * Determine to/cc URL arrays based on Mastodon-style visibility.
 * Mirrors resolveAddressing() in noteSerializer.ts.
 */
export function resolveAddressing(
  visibility: string,
  followersUri: string,
): { tos: URL[]; ccs: URL[] } {
  switch (visibility) {
    case 'public':
      return {
        tos: [new URL(AS_PUBLIC)],
        ccs: [new URL(followersUri)],
      };
    case 'unlisted':
      return {
        tos: [new URL(followersUri)],
        ccs: [new URL(AS_PUBLIC)],
      };
    case 'private':
      return {
        tos: [new URL(followersUri)],
        ccs: [],
      };
    case 'direct':
      return {
        tos: [],
        ccs: [],
      };
    default:
      return {
        tos: [new URL(AS_PUBLIC)],
        ccs: [new URL(followersUri)],
      };
  }
}
