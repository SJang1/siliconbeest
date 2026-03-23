/**
 * Mastodon API Serializers
 *
 * Convert D1 database rows into Mastodon REST API entity shapes.
 * See: https://docs.joinmastodon.org/entities/
 */

import type {
  Account as MastodonAccount,
  Status as MastodonStatus,
  MediaAttachment as MastodonMediaAttachment,
  MediaAttachmentMeta,
  Notification as MastodonNotification,
  NotificationType,
  Poll as MastodonPoll,
  PollOption,
  Relationship as MastodonRelationship,
  Application as MastodonApplication,
  List as MastodonList,
  Tag as MastodonTag,
  Conversation as MastodonConversation,
  Filter as MastodonFilter,
  FilterContext,
  FilterKeyword,
  FilterStatus,
  MarkerEntry as MastodonMarker,
  Source,
  Field,
  Emoji,
  StatusMention,
} from '../types/mastodon';

import type {
  AccountRow,
  StatusRow,
  MediaAttachmentRow,
  NotificationRow,
  PollRow,
  OAuthApplicationRow,
  ListRow,
  TagRow,
  ConversationRow,
  FilterRow,
  MarkerRow,
} from '../types/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a D1 integer (0/1) to a boolean. */
function bool(value: number | undefined | null): boolean {
  return value === 1;
}

/** Return an ISO 8601 string or null. */
function isoOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export function serializeAccount(
  row: AccountRow,
  opts?: { source?: Source; fields?: Field[] },
): MastodonAccount {
  const isLocal = row.domain === null || row.domain === '';
  const acct = isLocal ? row.username : `${row.username}@${row.domain}`;
  const url = row.url ?? row.uri;

  const account: MastodonAccount = {
    id: row.id,
    username: row.username,
    acct,
    display_name: row.display_name || '',
    note: row.note || '',
    url,
    uri: row.uri,
    avatar: row.avatar_url,
    avatar_static: row.avatar_static_url || row.avatar_url,
    header: row.header_url,
    header_static: row.header_static_url || row.header_url,
    locked: bool(row.locked),
    bot: bool(row.bot),
    discoverable: bool(row.discoverable),
    group: false,
    created_at: row.created_at,
    last_status_at: isoOrNull(row.last_status_at),
    statuses_count: row.statuses_count,
    followers_count: row.followers_count,
    following_count: row.following_count,
    fields: opts?.fields ?? [],
    emojis: [],
  };

  if (opts?.source) {
    account.source = opts.source;
  }

  if (row.suspended_at) {
    account.suspended = true;
  }

  return account;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function serializeStatus(
  row: StatusRow,
  opts: {
    account: MastodonAccount;
    mediaAttachments?: MastodonMediaAttachment[];
    reblog?: MastodonStatus | null;
    poll?: MastodonPoll | null;
    favourited?: boolean;
    reblogged?: boolean;
    bookmarked?: boolean;
    pinned?: boolean;
    mentions?: StatusMention[];
    tags?: MastodonTag[];
    emojis?: Emoji[];
  },
): MastodonStatus {
  return {
    id: row.id,
    uri: row.uri,
    url: row.url ?? null,
    account: opts.account,
    content: row.content || '',
    visibility: row.visibility as MastodonStatus['visibility'],
    sensitive: bool(row.sensitive),
    spoiler_text: row.content_warning || '',
    media_attachments: opts.mediaAttachments ?? [],
    created_at: row.created_at,
    edited_at: isoOrNull(row.edited_at),
    reblogs_count: row.reblogs_count,
    favourites_count: row.favourites_count,
    replies_count: row.replies_count,
    in_reply_to_id: row.in_reply_to_id ?? null,
    in_reply_to_account_id: row.in_reply_to_account_id ?? null,
    reblog: opts.reblog ?? null,
    poll: opts.poll ?? null,
    card: null,
    language: row.language || null,
    text: null,
    favourited: opts.favourited ?? null,
    reblogged: opts.reblogged ?? null,
    bookmarked: opts.bookmarked ?? null,
    muted: null,
    pinned: opts.pinned ?? null,
    emojis: opts.emojis ?? [],
    tags: opts.tags ?? [],
    mentions: opts.mentions ?? [],
  };
}

// ---------------------------------------------------------------------------
// Media Attachment
// ---------------------------------------------------------------------------

export function serializeMediaAttachment(
  row: MediaAttachmentRow,
): MastodonMediaAttachment {
  const meta: MediaAttachmentMeta | null =
    row.width != null && row.height != null
      ? {
          original: {
            width: row.width,
            height: row.height,
            aspect: row.height > 0 ? row.width / row.height : undefined,
          },
        }
      : null;

  return {
    id: row.id,
    type: row.type as MastodonMediaAttachment['type'],
    url: row.file_key,
    preview_url: row.thumbnail_key ?? null,
    remote_url: row.remote_url ?? null,
    description: row.description || null,
    blurhash: row.blurhash ?? null,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

export function serializeNotification(
  row: NotificationRow,
  opts: {
    account: MastodonAccount;
    status?: MastodonStatus | null;
  },
): MastodonNotification {
  const notification: MastodonNotification = {
    id: row.id,
    type: row.type as NotificationType,
    created_at: row.created_at,
    account: opts.account,
  };

  if (opts.status !== undefined) {
    notification.status = opts.status;
  }

  return notification;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export function serializePoll(
  row: PollRow,
  opts?: { voted?: boolean; ownVotes?: number[] },
): MastodonPoll {
  let options: PollOption[];
  try {
    const parsed = JSON.parse(row.options) as Array<string | { title: string; votes_count?: number }>;
    options = parsed.map((o) => {
      if (typeof o === 'string') {
        return { title: o, votes_count: null };
      }
      return { title: o.title, votes_count: o.votes_count ?? null };
    });
  } catch {
    options = [];
  }

  const expired = row.expires_at ? new Date(row.expires_at) <= new Date() : false;

  return {
    id: row.id,
    expires_at: isoOrNull(row.expires_at),
    expired,
    multiple: bool(row.multiple),
    votes_count: row.votes_count,
    voters_count: row.voters_count,
    options,
    voted: opts?.voted ?? null,
    own_votes: opts?.ownVotes ?? null,
    emojis: [],
  };
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

export function serializeRelationship(data: {
  id: string;
  following: boolean;
  followedBy: boolean;
  blocking: boolean;
  blockedBy: boolean;
  muting: boolean;
  mutingNotifications: boolean;
  requested: boolean;
  showingReblogs: boolean;
  notifying: boolean;
  domainBlocking: boolean;
  endorsed: boolean;
  note: string;
}): MastodonRelationship {
  return {
    id: data.id,
    following: data.following,
    showing_reblogs: data.showingReblogs,
    notifying: data.notifying,
    followed_by: data.followedBy,
    blocking: data.blocking,
    blocked_by: data.blockedBy,
    muting: data.muting,
    muting_notifications: data.mutingNotifications,
    requested: data.requested,
    requested_by: false,
    domain_blocking: data.domainBlocking,
    endorsed: data.endorsed,
    note: data.note,
    languages: null,
  };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export function serializeApplication(
  row: OAuthApplicationRow,
): MastodonApplication {
  return {
    name: row.name,
    website: row.website ?? null,
    client_id: row.client_id,
    client_secret: row.client_secret,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function serializeList(row: ListRow): MastodonList {
  return {
    id: row.id,
    title: row.title,
    replies_policy: row.replies_policy as MastodonList['replies_policy'],
    exclusive: bool(row.exclusive),
  };
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export function serializeTag(row: TagRow): MastodonTag {
  return {
    name: row.name,
    url: row.name, // caller should replace with full URL
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export function serializeConversation(
  row: ConversationRow,
  opts: {
    accounts: MastodonAccount[];
    lastStatus: MastodonStatus | null;
    unread: boolean;
  },
): MastodonConversation {
  return {
    id: row.id,
    accounts: opts.accounts,
    last_status: opts.lastStatus,
    unread: opts.unread,
  };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export function serializeFilter(
  row: FilterRow,
  opts?: {
    keywords?: Array<{ id: string; keyword: string; whole_word: number }>;
    statuses?: Array<{ id: string; status_id: string }>;
  },
): MastodonFilter {
  let context: FilterContext[];
  try {
    context = JSON.parse(row.context) as FilterContext[];
  } catch {
    context = [];
  }

  const keywords: FilterKeyword[] = (opts?.keywords ?? []).map((k) => ({
    id: k.id,
    keyword: k.keyword,
    whole_word: bool(k.whole_word),
  }));

  const statuses: FilterStatus[] = (opts?.statuses ?? []).map((s) => ({
    id: s.id,
    status_id: s.status_id,
  }));

  return {
    id: row.id,
    title: row.title,
    context,
    filter_action: row.action as 'warn' | 'hide',
    keywords,
    statuses,
    expires_at: isoOrNull(row.expires_at),
  };
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

export function serializeMarker(row: MarkerRow): MastodonMarker {
  return {
    last_read_id: row.last_read_id,
    version: row.version,
    updated_at: row.updated_at,
  };
}
