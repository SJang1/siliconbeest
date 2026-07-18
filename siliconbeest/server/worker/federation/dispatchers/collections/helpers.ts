/**
 * Shared helpers for collection dispatchers and object dispatchers.
 *
 * Extracted from the monolithic collections.ts (originally ~200 lines of helpers
 * at the bottom of an 861-line file). These are used by both collection
 * dispatchers and the Note/activity object dispatchers.
 */

import {
  Article,
  Note,
  Question,
  Image,
  Document as APDocument,
  Source,
  Emoji as APEmoji,
  InteractionPolicy,
  InteractionRule,
  Collection,
  CollectionPage,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { AccountRow, StatusRow, PollRow } from '../../../types/db';
import { normalizeQuotePolicy, quotePolicyAutomaticApprovals } from '../../../../../../packages/shared/utils/quotePolicy';
import { canEmbedQuote } from '../../../../../../packages/shared/permissions';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function buildCanQuoteRule(status: StatusRow, actorUri: string): InteractionRule {
  const policy = normalizeQuotePolicy(status.quote_policy);
  const values: ConstructorParameters<typeof InteractionRule>[0] = {
    automaticApprovals: quotePolicyAutomaticApprovals(policy, actorUri, `${actorUri}/followers`)
      .map((uri) => new URL(uri)),
  };
  return new InteractionRule(values);
}

function buildStatusCollection(uri: string, name: 'replies' | 'shares' | 'likes', totalItems: number): Collection {
  if (name === 'replies') {
    const collectionUri = `${uri}/replies`;
    return new Collection({
      id: new URL(collectionUri),
      first: new CollectionPage({
        id: new URL(`${collectionUri}?page=true`),
        partOf: new URL(collectionUri),
        next: new URL(`${collectionUri}?only_other_accounts=true&page=true`),
      }),
    });
  }

  return new Collection({
    id: new URL(`${uri}/${name}`),
    totalItems,
  });
}

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

/** Result from building a Fedify Article with addressing info. */
export interface FedifyArticleResult {
  article: Article;
  tos: URL[];
  ccs: URL[];
}

type StatusObjectHelpers = {
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
  quoteUriMap: Map<string, string>;
};

function buildFedifyObjectValues(
  status: StatusRow,
  account: AccountRow,
  domain: string,
  helpers: StatusObjectHelpers,
): {
  values: ConstructorParameters<typeof Note>[0];
  tos: URL[];
  ccs: URL[];
} {
  const actorUri = `https://${domain}/users/${account.username}`;
  const followersUri = `${actorUri}/followers`;
  const { tos, ccs } = resolveAddressing(status.visibility, followersUri);

  let replyTarget: URL | null = null;
  if (status.in_reply_to_id) {
    if (status.in_reply_to_id.startsWith('http')) {
      replyTarget = new URL(status.in_reply_to_id);
    } else {
      const resolvedUri = helpers.replyUriMap.get(status.in_reply_to_id);
      replyTarget = new URL(
        resolvedUri ?? `https://${domain}/users/${account.username}/statuses/${status.in_reply_to_id}`,
      );
    }
  }

  const attachments = (helpers.mediaMap.get(status.id) ?? []).map(buildMediaAttachment);
  const values: ConstructorParameters<typeof Note>[0] = {
    id: new URL(status.uri),
    attribution: new URL(actorUri),
    content: status.content,
    url: new URL(status.url ?? `https://${domain}/@${account.username}/${status.id}`),
    published: toTemporalInstant(status.created_at),
    tos,
    ccs,
    sensitive: status.sensitive === 1,
    summary: status.content_warning || null,
    replies: buildStatusCollection(status.uri, 'replies', status.replies_count ?? 0),
    shares: buildStatusCollection(status.uri, 'shares', status.reblogs_count ?? 0),
    likes: buildStatusCollection(status.uri, 'likes', status.favourites_count ?? 0),
    interactionPolicy: new InteractionPolicy({
      canQuote: buildCanQuoteRule(status, actorUri),
    }),
  };

  if (replyTarget) values.replyTarget = replyTarget;
  if (attachments.length > 0) values.attachments = attachments;
  if (status.edited_at) values.updated = toTemporalInstant(status.edited_at);
  if (status.text) {
    values.source = new Source({ content: status.text, mediaType: 'text/plain' });
  }

  const quoteStatusId = status.quote_id;
  if (quoteStatusId && canEmbedQuote({
    quoteStatusId,
    quoteApprovalStatus: status.quote_approval_status ?? null,
  })) {
    const quoteUri = helpers.quoteUriMap.get(quoteStatusId);
    if (quoteUri) {
      values.quote = new URL(quoteUri);
      values.quoteUrl = new URL(quoteUri);
    }
  }
  if (status.quote_authorization_uri) {
    values.quoteAuthorization = new URL(status.quote_authorization_uri);
  }

  const emojiTagObjects: APEmoji[] = [];
  if (status.emoji_tags) {
    try {
      const emojiTags = JSON.parse(status.emoji_tags) as Array<{ shortcode: string; url: string }>;
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
  if (emojiTagObjects.length > 0) values.tags = emojiTagObjects;

  return { values, tos, ccs };
}

/** Result from building a Fedify Question with addressing info. */
export interface FedifyQuestionResult {
  question: Question;
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
  helpers: StatusObjectHelpers,
): FedifyNoteResult {
  const { values, tos, ccs } = buildFedifyObjectValues(status, account, domain, helpers);
  const note = new Note(values);
  return { note, tos, ccs };
}

/** Build a long-form ActivityStreams Article from a status row. */
export function buildFedifyArticle(
  status: StatusRow,
  account: AccountRow,
  domain: string,
  helpers: StatusObjectHelpers,
): FedifyArticleResult {
  const { values, tos, ccs } = buildFedifyObjectValues(status, account, domain, helpers);
  const article = new Article({
    ...values,
    name: status.title || null,
  } as ConstructorParameters<typeof Article>[0]);
  return { article, tos, ccs };
}

/**
 * Build a Fedify Question from a StatusRow + PollRow.
 * Reuses the same addressing/attachment/emoji logic as buildFedifyNote.
 */
export function buildFedifyQuestion(
  status: StatusRow,
  account: AccountRow,
  poll: PollRow,
  domain: string,
  helpers: {
    convMap: Map<string, string | null>;
    mediaMap: Map<string, { url: string; mediaType: string; description: string; width: number | null; height: number | null; blurhash: string | null; type: string }[]>;
    replyUriMap: Map<string, string>;
    quoteUriMap: Map<string, string>;
  },
): FedifyQuestionResult {
  // Build the base Note first to reuse all shared logic
  const { note, tos, ccs } = buildFedifyNote(status, account, domain, helpers);

  // Parse poll options
  const options: Array<{ title: string; votes_count: number }> = JSON.parse(poll.options);
  const optionNotes = options.map((o) => new Note({ name: o.title }));
  const actorUri = `https://${domain}/users/${account.username}`;

  // Build Question values from the Note's JSON-LD-compatible properties
  const questionValues: ConstructorParameters<typeof Question>[0] = {
    id: note.id,
    content: status.content,
    url: note.url,
    published: toTemporalInstant(status.created_at),
    tos: tos.map((u) => u),
    ccs: ccs.map((u) => u),
    sensitive: status.sensitive === 1,
    summary: status.content_warning || null,
    replies: buildStatusCollection(status.uri, 'replies', status.replies_count ?? 0),
    shares: buildStatusCollection(status.uri, 'shares', status.reblogs_count ?? 0),
    likes: buildStatusCollection(status.uri, 'likes', status.favourites_count ?? 0),
    interactionPolicy: new InteractionPolicy({
      canQuote: buildCanQuoteRule(status, actorUri),
    }),
  };

  // Set actor URI (Question is an Activity, needs actor)
  questionValues.actor = new URL(actorUri);

  if (poll.multiple) {
    questionValues.inclusiveOptions = optionNotes;
  } else {
    questionValues.exclusiveOptions = optionNotes;
  }

  if (poll.expires_at) {
    questionValues.endTime = Temporal.Instant.from(new Date(poll.expires_at).toISOString());
  }

  // Mark as closed if expired
  if (poll.expires_at && new Date(poll.expires_at) <= new Date()) {
    questionValues.closed = Temporal.Instant.from(new Date(poll.expires_at).toISOString());
  }

  questionValues.voters = poll.voters_count;

  if (status.edited_at) {
    questionValues.updated = toTemporalInstant(status.edited_at);
  }

  if (status.text) {
    questionValues.source = new Source({
      content: status.text,
      mediaType: 'text/plain',
    });
  }

  const quoteStatusId = status.quote_id;
  if (quoteStatusId && canEmbedQuote({
    quoteStatusId,
    quoteApprovalStatus: status.quote_approval_status ?? null,
  })) {
    const quoteUri = helpers.quoteUriMap.get(quoteStatusId);
    if (quoteUri) {
      questionValues.quote = new URL(quoteUri);
      questionValues.quoteUrl = new URL(quoteUri);
    }
  }

  if (status.quote_authorization_uri) {
    questionValues.quoteAuthorization = new URL(status.quote_authorization_uri);
  }

  // Carry over attachments
  const attachments = (helpers.mediaMap.get(status.id) ?? []).map(buildMediaAttachment);
  if (attachments.length > 0) {
    questionValues.attachments = attachments;
  }

  // Carry over emoji tags
  const emojiTagObjects: APEmoji[] = [];
  if (status.emoji_tags) {
    try {
      const emojiTags = JSON.parse(status.emoji_tags) as Array<{ shortcode: string; url: string }>;
      for (const et of emojiTags) {
        if (!et.shortcode || !et.url) continue;
        emojiTagObjects.push(new APEmoji({
          id: new URL(et.url),
          name: `:${et.shortcode}:`,
          icon: new Image({ url: new URL(et.url), mediaType: 'image/png' }),
        }));
      }
    } catch { /* ignore */ }
  }
  if (emojiTagObjects.length > 0) {
    questionValues.tags = emojiTagObjects;
  }

  const question = new Question(questionValues);
  return { question, tos, ccs };
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
