// Mastodon API entity types for the frontend
//
// Common base types are imported from packages/shared/types/mastodon-base.ts
// to maintain a single source of truth between server and frontend.

// Re-export shared base types
export type {
  AccountField,
  CustomEmoji,
  PollOption,
  TagHistory,
  FilterContext,
  FilterKeyword,
  FilterStatus,
  NotificationType,
  Token,
  List,
  Relationship,
} from '../../../packages/shared/types/mastodon-base';

import type {
  AccountField,
  CustomEmoji,
  PollOption,
  TagHistory,
  FilterContext,
  FilterKeyword,
  FilterStatus,
  NotificationType,
} from '../../../packages/shared/types/mastodon-base';

export interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable: boolean | null;
  group: boolean;
  created_at: string;
  note: string;
  url: string;
  uri: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at: string | null;
  emojis: CustomEmoji[];
  fields: AccountField[];
  moved?: Account | null;
  suspended?: boolean;
  limited?: boolean;
  memorial?: boolean;
  noindex?: boolean;
  roles?: Role[];
}

export interface Role {
  id: string;
  name: string;
  color: string;
}

export interface CredentialAccount extends Account {
  source: AccountSource;
  role?: Role;
}

export interface AccountSource {
  privacy: StatusVisibility;
  sensitive: boolean;
  language: string;
  note: string;
  fields: AccountField[];
  follow_requests_count: number;
}

export type StatusVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface Status {
  id: string;
  uri: string;
  created_at: string;
  account: Account;
  content: string;
  visibility: StatusVisibility;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  application: Application | null;
  mentions: Mention[];
  tags: Tag[];
  emojis: CustomEmoji[];
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  url: string | null;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog: Status | null;
  poll: Poll | null;
  card: PreviewCard | null;
  language: string | null;
  text: string | null;
  edited_at: string | null;
  favourited?: boolean;
  reblogged?: boolean;
  muted?: boolean;
  bookmarked?: boolean;
  pinned?: boolean;
  filtered?: FilterResult[];
  emoji_reactions?: EmojiReaction[];
}

export interface EmojiReaction {
  name: string;
  count: number;
  me: boolean;
  url: string | null;
  static_url: string | null;
  accounts?: Account[];
}

export interface MediaAttachment {
  id: string;
  type: 'unknown' | 'image' | 'gifv' | 'video' | 'audio';
  url: string;
  preview_url: string | null;
  remote_url: string | null;
  meta: Record<string, unknown> | null;
  description: string | null;
  blurhash: string | null;
}

export interface Application {
  name: string;
  website: string | null;
}

export interface Mention {
  id: string;
  username: string;
  url: string;
  acct: string;
}

export interface Tag {
  name: string;
  url: string;
  history?: TagHistory[];
  following?: boolean;
}

export interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  options: PollOption[];
  emojis: CustomEmoji[];
  voted?: boolean;
  own_votes?: number[];
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

export interface Notification {
  id: string;
  type: NotificationType;
  created_at: string;
  group_key?: string;
  account: Account;
  status?: Status;
  read?: boolean;
  emoji?: string;
  emoji_url?: string;
}

export interface Conversation {
  id: string;
  unread: boolean;
  accounts: Account[];
  last_status: Status | null;
}

export interface FilterResult {
  filter: Filter;
  keyword_matches: string[] | null;
  status_matches: string | null;
}

export interface Filter {
  id: string;
  title: string;
  context: FilterContext[];
  expires_at: string | null;
  filter_action: 'warn' | 'hide';
  keywords: FilterKeyword[];
  statuses: FilterStatus[];
}

export interface Instance {
  domain: string;
  title: string;
  version: string;
  source_url: string;
  description: string;
  usage: {
    users: {
      active_month: number;
    };
  };
  thumbnail: {
    url: string;
    blurhash: string | null;
    versions: Record<string, string>;
  } | null;
  languages: string[];
  configuration: InstanceConfiguration;
  registrations: {
    enabled: boolean;
    approval_required: boolean;
    message: string | null;
  };
  contact: {
    email: string;
    account: Account | null;
  };
  rules: InstanceRule[];
  site_landing_markdown?: string;
  terms_of_service?: string;
  privacy_policy?: string;
}

export interface InstanceConfiguration {
  urls: {
    streaming: string;
  };
  accounts: {
    max_featured_tags: number;
  };
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
  translation: {
    enabled: boolean;
  };
  turnstile?: {
    enabled: boolean;
    site_key: string;
  };
}

export interface InstanceRule {
  id: string;
  text: string;
  hint: string;
}

export interface SearchResults {
  accounts: Account[];
  statuses: Status[];
  hashtags: Tag[];
}

export interface Context {
  ancestors: Status[];
  descendants: Status[];
}

export interface Marker {
  last_read_id: string;
  version: number;
  updated_at: string;
}

export interface OAuthApp {
  id: string;
  name: string;
  website: string | null;
  redirect_uri: string;
  client_id: string;
  client_secret: string;
  vapid_key: string;
}

export interface Announcement {
  id: string;
  content: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  published_at: string;
  updated_at: string;
  read: boolean | null;
  mentions: Mention[];
  statuses: Status[];
  tags: Tag[];
  emojis: CustomEmoji[];
  reactions: AnnouncementReaction[];
}

export interface AnnouncementReaction {
  name: string;
  count: number;
  me: boolean;
  url: string | null;
  static_url: string | null;
}

// Pagination options used across API calls
export interface PaginationOpts {
  max_id?: string;
  since_id?: string;
  min_id?: string;
  limit?: number;
  token?: string;
}
