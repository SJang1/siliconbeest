/**
 * Mastodon REST API Entity Types
 *
 * These types represent the JSON shapes returned by the Mastodon-compatible API.
 * See: https://docs.joinmastodon.org/entities/
 *
 * Common base types are imported from packages/shared/types/mastodon-base.ts
 * to maintain a single source of truth between server and frontend.
 */

// Re-export shared base types
export type {
  AccountField,
  CustomEmoji,
  PollOption,
  TagHistory,
  BaseTag,
  FilterContext,
  FilterKeyword,
  FilterStatus,
  NotificationType,
  Token,
  List,
  BaseConversation,
  Relationship,
} from '../../../../packages/shared/types/mastodon-base';

import type {
  AccountField,
  CustomEmoji,
  PollOption,
  TagHistory,
  FilterContext,
  FilterKeyword,
  FilterStatus,
  NotificationType,
} from '../../../../packages/shared/types/mastodon-base';

// ============================================================
// PRIMITIVES / SHARED
// ============================================================

/** @deprecated Use AccountField instead */
export type Field = AccountField;

/** @deprecated Use CustomEmoji instead */
export type Emoji = CustomEmoji;

export interface Source {
  privacy: string;
  sensitive: boolean;
  language: string;
  note: string;
  fields: Field[];
  follow_requests_count: number;
}

// ============================================================
// ACCOUNT
// ============================================================

export interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  note: string;
  url: string;
  uri: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  locked: boolean;
  bot: boolean;
  discoverable: boolean | null;
  group: boolean;
  created_at: string;
  last_status_at: string | null;
  statuses_count: number;
  followers_count: number;
  following_count: number;
  fields: Field[];
  emojis: Emoji[];
  source?: Source;
  moved?: Account | null;
  suspended?: boolean;
  limited?: boolean;
  noindex?: boolean;
  role?: AccountRole;
}

export interface AccountRole {
  id: string;
  name: string;
  color: string;
  permissions: number;
  highlighted: boolean;
}

export interface CredentialAccount extends Account {
  source: Source;
  role: AccountRole;
}

// ============================================================
// STATUS
// ============================================================

export interface Status {
  id: string;
  uri: string;
  url: string | null;
  account: Account;
  content: string;
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  created_at: string;
  edited_at: string | null;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog: Status | null;
  /** FEP-e232: Quoted status (quote post) */
  quote?: Status | null;
  poll: Poll | null;
  card: PreviewCard | null;
  language: string | null;
  text: string | null;
  favourited: boolean | null;
  reblogged: boolean | null;
  bookmarked: boolean | null;
  muted: boolean | null;
  pinned: boolean | null;
  filtered?: FilterResult[];
  application?: Application | null;
  emojis: Emoji[];
  tags: Tag[];
  mentions: StatusMention[];
}

export interface StatusMention {
  id: string;
  username: string;
  acct: string;
  url: string;
}

export interface PreviewCard {
  url: string;
  title: string;
  description: string;
  type: 'link' | 'photo' | 'video' | 'rich';
  author_name: string;
  author_url: string;
  provider_name: string;
  provider_url: string;
  html: string;
  width: number;
  height: number;
  image: string | null;
  embed_url: string;
  blurhash: string | null;
}

// ============================================================
// MEDIA ATTACHMENT
// ============================================================

export interface MediaAttachmentMeta {
  original?: {
    width: number;
    height: number;
    size?: string;
    aspect?: number;
  };
  small?: {
    width: number;
    height: number;
    size?: string;
    aspect?: number;
  };
  focus?: {
    x: number;
    y: number;
  };
}

export interface MediaAttachment {
  id: string;
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown';
  url: string;
  preview_url: string | null;
  remote_url: string | null;
  text_url?: string | null;
  description: string | null;
  blurhash: string | null;
  meta: MediaAttachmentMeta | null;
}

// ============================================================
// POLL
// ============================================================

export interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  options: PollOption[];
  voted: boolean | null;
  own_votes: number[] | null;
  emojis: Emoji[];
}

// ============================================================
// NOTIFICATION
// ============================================================

export interface Notification {
  id: string;
  type: NotificationType;
  created_at: string;
  account: Account;
  status?: Status | null;
  report?: Report | null;
}

// ============================================================
// OAUTH / APPLICATION
// ============================================================

export interface Application {
  name: string;
  website: string | null;
  client_id?: string;
  client_secret?: string;
  vapid_key?: string;
}

// ============================================================
// CONTEXT
// ============================================================

export interface Context {
  ancestors: Status[];
  descendants: Status[];
}

// ============================================================
// RELATIONSHIP
// ============================================================

// ============================================================
// INSTANCE
// ============================================================

export interface InstanceStats {
  user_count: number;
  status_count: number;
  domain_count: number;
}

export interface InstanceUrls {
  streaming_api: string;
}

export interface InstanceConfiguration {
  statuses: {
    max_characters: number;
    max_media_attachments: number;
    characters_reserved_per_url: number;
  };
  media_attachments: {
    supported_mime_types: string[];
    image_size_limit: number;
    image_matrix_limit: number;
    video_size_limit: number;
    video_frame_rate_limit: number;
    video_matrix_limit: number;
  };
  polls: {
    max_options: number;
    max_characters_per_option: number;
    min_expiration: number;
    max_expiration: number;
  };
}

export interface Instance {
  domain: string;
  title: string;
  description: string;
  short_description: string;
  email: string;
  version: string;
  languages: string[];
  registrations: boolean;
  approval_required: boolean;
  invites_enabled: boolean;
  stats: InstanceStats;
  urls: InstanceUrls;
  thumbnail: string | null;
  contact_account: Account | null;
  rules: Rule[];
  configuration: InstanceConfiguration;
}

// ============================================================
// WEB PUSH
// ============================================================

export interface WebPushAlerts {
  mention: boolean;
  follow: boolean;
  favourite: boolean;
  reblog: boolean;
  poll: boolean;
  status: boolean;
  update: boolean;
  'admin.sign_up': boolean;
  'admin.report': boolean;
  follow_request: boolean;
}

export interface WebPushSubscription {
  id: string;
  endpoint: string;
  alerts: WebPushAlerts;
  server_key: string;
  policy: string;
}

// ============================================================
// FILTER
// ============================================================

export interface Filter {
  id: string;
  title: string;
  context: FilterContext[];
  filter_action: 'warn' | 'hide';
  keywords: FilterKeyword[];
  statuses: FilterStatus[];
  expires_at: string | null;
}

export interface FilterResult {
  filter: Filter;
  keyword_matches: string[] | null;
  status_matches: string[] | null;
}

// ============================================================
// MARKER
// ============================================================

export interface MarkerEntry {
  last_read_id: string;
  version: number;
  updated_at: string;
}

export interface Markers {
  home?: MarkerEntry;
  notifications?: MarkerEntry;
}

// ============================================================
// LIST
// ============================================================

export interface Tag {
  name: string;
  url: string;
  history?: TagHistory[];
  following?: boolean;
}

// ============================================================
// CONVERSATION
// ============================================================

export interface Conversation {
  id: string;
  accounts: Account[];
  last_status: Status | null;
  unread: boolean;
}

// ============================================================
// REPORT
// ============================================================

export interface Report {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  status_ids: string[] | null;
  rule_ids: string[] | null;
  target_account: Account;
  created_at: string;
}

// ============================================================
// RULE
// ============================================================

export interface Rule {
  id: string;
  text: string;
}

// ============================================================
// ANNOUNCEMENT
// ============================================================

export interface Announcement {
  id: string;
  text: string;
  published: boolean;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  read?: boolean;
  emojis: Emoji[];
  reactions: AnnouncementReaction[];
  tags: Tag[];
  mentions: StatusMention[];
  created_at: string;
  updated_at: string;
}

export interface AnnouncementReaction {
  name: string;
  count: number;
  me: boolean;
  url?: string;
  static_url?: string;
}

// ============================================================
// ERROR
// ============================================================

export interface MastodonError {
  error: string;
  error_description?: string;
}

// ============================================================
// PREFERENCES
// ============================================================

export interface Preferences {
  'posting:default:visibility': string;
  'posting:default:sensitive': boolean;
  'posting:default:language': string | null;
  'reading:expand:media': string;
  'reading:expand:spoilers': boolean;
}
