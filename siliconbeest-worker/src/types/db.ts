/**
 * D1 Database Row Types
 *
 * All IDs are TEXT (ULID strings).
 * All timestamps are TEXT (ISO 8601 strings).
 * All booleans are INTEGER (0 or 1).
 */

// ============================================================
// CORE TABLES
// ============================================================

export interface AccountRow {
  id: string;
  username: string;
  domain: string | null;
  display_name: string;
  note: string;
  uri: string;
  url: string | null;
  avatar_url: string;
  avatar_static_url: string;
  header_url: string;
  header_static_url: string;
  locked: number;
  bot: number;
  discoverable: number;
  manually_approves_followers: number;
  statuses_count: number;
  followers_count: number;
  following_count: number;
  last_status_at: string | null;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
  silenced_at: string | null;
  memorial: number;
  moved_to_account_id: string | null;
  also_known_as?: string | null;
  moved_at?: string | null;
  /** JSON array of emoji tag objects from ActivityPub actor document */
  emoji_tags?: string | null;
}

export interface UserRow {
  id: string;
  account_id: string;
  email: string;
  encrypted_password: string;
  locale: string;
  confirmed_at: string | null;
  confirmation_token: string | null;
  reset_password_token: string | null;
  reset_password_sent_at: string | null;
  otp_secret: string | null;
  otp_enabled: number;
  otp_backup_codes: string | null;
  role: string;
  approved: number;
  disabled: number;
  sign_in_count: number;
  current_sign_in_at: string | null;
  last_sign_in_at: string | null;
  current_sign_in_ip: string | null;
  last_sign_in_ip: string | null;
  chosen_languages: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActorKeyRow {
  id: string;
  account_id: string;
  public_key: string;
  private_key: string;
  key_id: string;
  ed25519_public_key: string | null;
  ed25519_private_key: string | null;
  created_at: string;
}

export interface StatusRow {
  id: string;
  uri: string;
  url: string | null;
  account_id: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog_of_id: string | null;
  text: string;
  content: string;
  content_warning: string;
  visibility: string;
  sensitive: number;
  language: string;
  conversation_id: string | null;
  reply: number;
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  local: number;
  federated_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  poll_id: string | null;
  /** FEP-e232: ID of the status being quoted (quote post) */
  quote_id: string | null;
  /** JSON array of emoji tag objects from ActivityPub for lazy-load rendering */
  emoji_tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaAttachmentRow {
  id: string;
  status_id: string | null;
  account_id: string;
  file_key: string;
  file_content_type: string;
  file_size: number;
  thumbnail_key: string | null;
  remote_url: string | null;
  description: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  type: string;
  created_at: string;
  updated_at: string;
}

export interface PollRow {
  id: string;
  status_id: string;
  expires_at: string | null;
  multiple: number;
  votes_count: number;
  voters_count: number;
  options: string;
  created_at: string;
}

export interface PollVoteRow {
  id: string;
  poll_id: string;
  account_id: string;
  choice: number;
  created_at: string;
}

// ============================================================
// RELATIONSHIP TABLES
// ============================================================

export interface FollowRow {
  id: string;
  account_id: string;
  target_account_id: string;
  uri: string | null;
  show_reblogs: number;
  notify: number;
  languages: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowRequestRow {
  id: string;
  account_id: string;
  target_account_id: string;
  uri: string | null;
  created_at: string;
  updated_at: string;
}

export interface FavouriteRow {
  id: string;
  account_id: string;
  status_id: string;
  uri: string | null;
  created_at: string;
}

export interface BlockRow {
  id: string;
  account_id: string;
  target_account_id: string;
  uri: string | null;
  created_at: string;
}

export interface MuteRow {
  id: string;
  account_id: string;
  target_account_id: string;
  hide_notifications: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookmarkRow {
  id: string;
  account_id: string;
  status_id: string;
  created_at: string;
}

// ============================================================
// NOTIFICATIONS & MENTIONS
// ============================================================

export interface NotificationRow {
  id: string;
  account_id: string;
  from_account_id: string;
  type: string;
  status_id: string | null;
  emoji: string | null;
  read: number;
  created_at: string;
}

export interface MentionRow {
  id: string;
  status_id: string;
  account_id: string;
  silent: number;
  created_at: string;
}

// ============================================================
// TAGS (HASHTAGS)
// ============================================================

export interface TagRow {
  id: string;
  name: string;
  display_name: string | null;
  usable: number;
  trendable: number;
  listable: number;
  last_status_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatusTagRow {
  status_id: string;
  tag_id: string;
}

export interface TagFollowRow {
  id: string;
  account_id: string;
  tag_id: string;
  created_at: string;
}

// ============================================================
// OAUTH
// ============================================================

export interface OAuthApplicationRow {
  id: string;
  name: string;
  website: string | null;
  redirect_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  created_at: string;
  updated_at: string;
}

export interface OAuthAccessTokenRow {
  id: string;
  token: string;
  refresh_token: string | null;
  application_id: string;
  user_id: string | null;
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface OAuthAuthorizationCodeRow {
  id: string;
  code: string;
  application_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// ============================================================
// LISTS
// ============================================================

export interface ListRow {
  id: string;
  account_id: string;
  title: string;
  replies_policy: string;
  exclusive: number;
  created_at: string;
  updated_at: string;
}

export interface ListAccountRow {
  list_id: string;
  account_id: string;
  follow_id: string | null;
}

// ============================================================
// FEDERATION / INSTANCE MANAGEMENT
// ============================================================

export interface InstanceRow {
  id: string;
  domain: string;
  software_name: string | null;
  software_version: string | null;
  title: string | null;
  description: string | null;
  inbox_url: string | null;
  public_key: string | null;
  last_successful_at: string | null;
  last_failed_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface DomainBlockRow {
  id: string;
  domain: string;
  severity: string;
  reject_media: number;
  reject_reports: number;
  private_comment: string | null;
  public_comment: string | null;
  obfuscate: number;
  created_at: string;
  updated_at: string;
}

export interface DomainAllowRow {
  id: string;
  domain: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// WEB PUSH SUBSCRIPTIONS
// ============================================================

export interface WebPushSubscriptionRow {
  id: string;
  user_id: string;
  access_token_id: string;
  endpoint: string;
  key_p256dh: string;
  key_auth: string;
  alert_mention: number;
  alert_follow: number;
  alert_favourite: number;
  alert_reblog: number;
  alert_poll: number;
  alert_status: number;
  alert_update: number;
  alert_follow_request: number;
  alert_admin_sign_up: number;
  alert_admin_report: number;
  policy: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// REPORTS & MODERATION
// ============================================================

export interface ReportRow {
  id: string;
  account_id: string;
  target_account_id: string;
  status_ids: string | null;
  comment: string;
  category: string;
  action_taken: number;
  action_taken_at: string | null;
  action_taken_by_account_id: string | null;
  forwarded: number;
  created_at: string;
  updated_at: string;
}

export interface AccountWarningRow {
  id: string;
  account_id: string;
  target_account_id: string;
  action: string;
  text: string;
  report_id: string | null;
  created_at: string;
}

export interface IpBlockRow {
  id: string;
  ip: string;
  severity: string;
  comment: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDomainBlockRow {
  id: string;
  domain: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// TIMELINE & USER PREFERENCES
// ============================================================

export interface HomeTimelineEntryRow {
  id: string;
  account_id: string;
  status_id: string;
  created_at: string;
}

export interface MarkerRow {
  id: string;
  user_id: string;
  timeline: string;
  last_read_id: string;
  version: number;
  updated_at: string;
}

export interface UserPreferenceRow {
  id: string;
  user_id: string;
  key: string;
  value: string;
}

export interface FilterRow {
  id: string;
  user_id: string;
  title: string;
  context: string;
  action: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FilterKeywordRow {
  id: string;
  filter_id: string;
  keyword: string;
  whole_word: number;
  created_at: string;
  updated_at: string;
}

export interface FilterStatusRow {
  id: string;
  filter_id: string;
  status_id: string;
  created_at: string;
}

// ============================================================
// INSTANCE SETTINGS & CONTENT
// ============================================================

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface CustomEmojiRow {
  id: string;
  shortcode: string;
  domain: string | null;
  image_key: string;
  visible_in_picker: number;
  category: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementRow {
  id: string;
  text: string;
  published: number;
  starts_at: string | null;
  ends_at: string | null;
  all_day: number;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  text: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ============================================================
// CONVERSATIONS (DIRECT MESSAGES)
// ============================================================

export interface ConversationRow {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationAccountRow {
  conversation_id: string;
  account_id: string;
  last_status_id: string | null;
  unread: number;
}
