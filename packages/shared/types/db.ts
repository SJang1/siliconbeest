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

export type AccountRow = {
  readonly id: string;
  readonly username: string;
  readonly domain: string | null;
  readonly display_name: string;
  readonly note: string;
  readonly uri: string;
  readonly url: string | null;
  readonly avatar_url: string;
  readonly avatar_static_url: string;
  readonly header_url: string;
  readonly header_static_url: string;
  readonly locked: number;
  readonly bot: number;
  readonly discoverable: number | null;
  readonly manually_approves_followers: number;
  readonly hide_collections?: number;
  readonly statuses_count: number;
  readonly followers_count: number;
  readonly following_count: number;
  readonly last_status_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly suspended_at: string | null;
  readonly silenced_at: string | null;
  readonly memorial: number;
  readonly moved_to_account_id: string | null;
  readonly also_known_as?: string | null;
  readonly moved_at?: string | null;
  /** JSON array of emoji tag objects from ActivityPub actor document */
  readonly emoji_tags?: string | null;
  readonly fetched_at?: string | null;
  readonly fields?: string | null;
};

export type RegistrationState =
  | 'pending_approval'
  | 'awaiting_confirmation'
  | 'email_verification'
  | 'active';

export type RegistrationDesign = 'default' | 'aurora' | 'old';

export type UserRow = {
  readonly id: string;
  readonly account_id: string;
  readonly email: string;
  readonly encrypted_password: string;
  readonly locale: string;
  readonly confirmed_at: string | null;
  readonly confirmation_token: string | null;
  readonly reset_password_token: string | null;
  readonly reset_password_sent_at: string | null;
  readonly otp_secret: string | null;
  readonly otp_enabled: number;
  readonly otp_backup_codes: string | null;
  readonly role: string;
  readonly approved: number;
  readonly disabled: number;
  readonly sign_in_count: number;
  readonly current_sign_in_at: string | null;
  readonly last_sign_in_at: string | null;
  readonly current_sign_in_ip: string | null;
  readonly last_sign_in_ip: string | null;
  readonly chosen_languages: string | null;
  readonly default_quote_policy?: string | null;
  readonly registration_state: RegistrationState;
  readonly invite_id: string | null;
  readonly invited_by_account_id: string | null;
  readonly registration_redirect_uri: string | null;
  readonly registration_design: RegistrationDesign;
  readonly email_verification_code_hash: string | null;
  readonly email_verification_sent_at: string | null;
  readonly email_verification_expires_at: string | null;
  readonly email_verification_attempts: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type AccountInvitationBalanceRow = {
  readonly account_id: string;
  readonly available_credits: number;
  readonly contribution_score: number;
  readonly contribution_award_level: number;
  readonly last_operation_id: string | null;
  readonly last_credit_delta: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type InvitationAuditLogRow = {
  readonly id: string;
  readonly actor_account_id: string | null;
  readonly target_account_id: string | null;
  readonly invitation_id: string | null;
  readonly action: string;
  readonly credit_delta: number;
  readonly contribution_delta: number;
  readonly credits_after: number | null;
  readonly contribution_score_after: number | null;
  readonly metadata: string;
  readonly created_at: string;
};

export type RegistrationInviteRow = {
  readonly id: string;
  readonly token_hash: string;
  readonly inviter_account_id: string;
  readonly remaining_uses: number;
  readonly auto_follow: number;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly issued_uses: number;
  readonly revoked_unused_uses: number;
  readonly credits_restored_at: string | null;
  readonly credit_operation_id: string | null;
  readonly reset_at: string | null;
};

export type InvitationUseClaimRow = {
  readonly id: string;
  readonly invitation_id: string;
  readonly inviter_account_id: string;
  readonly assigned_user_id: string | null;
  readonly claimed_at: string;
  readonly expires_at: string;
};

export type InvitationUseDailyLimitRow = {
  readonly account_id: string;
  readonly window_started_at: string;
  readonly consumed_uses: number;
  readonly last_operation_id: string | null;
};

export type ActorKeyRow = {
  readonly id: string;
  readonly account_id: string;
  readonly public_key: string;
  readonly private_key: string;
  readonly key_id: string;
  readonly ed25519_public_key: string | null;
  readonly ed25519_private_key: string | null;
  readonly created_at: string;
};

export type StatusRow = {
  readonly id: string;
  readonly uri: string;
  readonly url: string | null;
  /** ActivityStreams object type. Poll rows are serialized as Question. */
  readonly object_type: 'Note' | 'Article';
  /** ActivityStreams name, used as the title of an Article. */
  readonly title: string;
  readonly account_id: string;
  readonly in_reply_to_id: string | null;
  readonly in_reply_to_account_id: string | null;
  readonly reblog_of_id: string | null;
  readonly text: string;
  readonly content: string;
  readonly content_warning: string;
  readonly visibility: string;
  readonly sensitive: number;
  readonly language: string;
  readonly conversation_id: string | null;
  readonly reply: number;
  readonly replies_count: number;
  readonly reblogs_count: number;
  readonly favourites_count: number;
  readonly local: number;
  readonly federated_at: string | null;
  readonly edited_at: string | null;
  readonly deleted_at: string | null;
  readonly poll_id: string | null;
  /** FEP-e232: ID of the status being quoted (quote post) */
  readonly quote_id: string | null;
  /** FEP-044f: URI of the approval stamp for this quote post. */
  readonly quote_authorization_uri?: string | null;
  /** FEP-044f: none | pending | accepted | rejected | revoked. */
  readonly quote_approval_status?: string | null;
  /** FEP-044f: URI of the QuoteRequest activity sent for this quote post. */
  readonly quote_request_uri?: string | null;
  /** FEP-044f: public | followers | nobody. */
  readonly quote_policy?: string | null;
  readonly quote_policy_automatic_approvals?: string | null;
  readonly quote_policy_manual_approvals?: string | null;
  /** JSON array of emoji tag objects from ActivityPub for lazy-load rendering */
  readonly emoji_tags: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type MediaAttachmentRow = {
  readonly id: string;
  readonly status_id: string | null;
  readonly account_id: string;
  readonly file_key: string;
  readonly file_content_type: string;
  readonly file_size: number;
  readonly thumbnail_key: string | null;
  readonly remote_url: string | null;
  readonly description: string;
  readonly blurhash: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly type: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PollRow = {
  readonly id: string;
  readonly status_id: string;
  readonly expires_at: string | null;
  readonly multiple: number;
  readonly votes_count: number;
  readonly voters_count: number;
  readonly options: string;
  readonly created_at: string;
};

export type PollVoteRow = {
  readonly id: string;
  readonly poll_id: string;
  readonly account_id: string;
  readonly choice: number;
  readonly created_at: string;
};

// ============================================================
// RELATIONSHIP TABLES
// ============================================================

export type FollowRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly uri: string | null;
  readonly show_reblogs: number;
  readonly notify: number;
  readonly languages: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type FollowRequestRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly uri: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type FavouriteRow = {
  readonly id: string;
  readonly account_id: string;
  readonly status_id: string;
  readonly uri: string | null;
  readonly created_at: string;
};

export type BlockRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly uri: string | null;
  readonly created_at: string;
};

export type MuteRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly hide_notifications: number;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type BookmarkRow = {
  readonly id: string;
  readonly account_id: string;
  readonly status_id: string;
  readonly created_at: string;
};

// ============================================================
// NOTIFICATIONS & MENTIONS
// ============================================================

export type NotificationRow = {
  readonly id: string;
  readonly account_id: string;
  readonly from_account_id: string;
  readonly type: string;
  readonly status_id: string | null;
  readonly emoji: string | null;
  readonly read: number;
  readonly created_at: string;
};

export type MentionRow = {
  readonly id: string;
  readonly status_id: string;
  readonly account_id: string;
  readonly silent: number;
  readonly created_at: string;
};

// ============================================================
// TAGS (HASHTAGS)
// ============================================================

export type TagRow = {
  readonly id: string;
  readonly name: string;
  readonly display_name: string | null;
  readonly usable: number;
  readonly trendable: number;
  readonly listable: number;
  readonly last_status_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type StatusTagRow = {
  readonly status_id: string;
  readonly tag_id: string;
};

export type TagFollowRow = {
  readonly id: string;
  readonly account_id: string;
  readonly tag_id: string;
  readonly created_at: string;
};

// ============================================================
// OAUTH
// ============================================================

export type OAuthApplicationRow = {
  readonly id: string;
  readonly name: string;
  readonly website: string | null;
  readonly redirect_uri: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly scopes: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type OAuthAccessTokenRow = {
  readonly id: string;
  readonly token: string;
  readonly token_hash: string | null;
  readonly refresh_token: string | null;
  readonly application_id: string;
  readonly user_id: string | null;
  readonly scopes: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
};

export type OAuthAuthorizationCodeRow = {
  readonly id: string;
  readonly code: string;
  readonly application_id: string;
  readonly user_id: string;
  readonly redirect_uri: string;
  readonly scopes: string;
  readonly code_challenge: string | null;
  readonly code_challenge_method: string | null;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly created_at: string;
};

// ============================================================
// LISTS
// ============================================================

export type ListRow = {
  readonly id: string;
  readonly account_id: string;
  readonly title: string;
  readonly replies_policy: string;
  readonly exclusive: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type ListAccountRow = {
  readonly list_id: string;
  readonly account_id: string;
  readonly follow_id: string | null;
};

// ============================================================
// FEDERATION / INSTANCE MANAGEMENT
// ============================================================

export type InstanceRow = {
  readonly id: string;
  readonly domain: string;
  readonly software_name: string | null;
  readonly software_version: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly inbox_url: string | null;
  readonly public_key: string | null;
  readonly last_successful_at: string | null;
  readonly last_failed_at: string | null;
  readonly failure_count: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type DomainBlockRow = {
  readonly id: string;
  readonly domain: string;
  readonly severity: string;
  readonly reject_media: number;
  readonly reject_reports: number;
  readonly private_comment: string | null;
  readonly public_comment: string | null;
  readonly obfuscate: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type DomainAllowRow = {
  readonly id: string;
  readonly domain: string;
  readonly created_at: string;
  readonly updated_at: string;
};

// ============================================================
// WEB PUSH SUBSCRIPTIONS
// ============================================================

export type WebPushSubscriptionRow = {
  readonly id: string;
  readonly user_id: string;
  readonly access_token_id: string;
  readonly endpoint: string;
  readonly key_p256dh: string;
  readonly key_auth: string;
  readonly alert_mention: number;
  readonly alert_follow: number;
  readonly alert_favourite: number;
  readonly alert_reblog: number;
  readonly alert_poll: number;
  readonly alert_status: number;
  readonly alert_update: number;
  readonly alert_follow_request: number;
  readonly alert_admin_sign_up: number;
  readonly alert_admin_report: number;
  readonly policy: string;
  readonly created_at: string;
  readonly updated_at: string;
};

// ============================================================
// REPORTS & MODERATION
// ============================================================

export type ReportRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly status_ids: string | null;
  readonly comment: string;
  readonly category: string;
  readonly action_taken: number;
  readonly action_taken_at: string | null;
  readonly action_taken_by_account_id: string | null;
  readonly forwarded: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type AccountWarningRow = {
  readonly id: string;
  readonly account_id: string;
  readonly target_account_id: string;
  readonly action: string;
  readonly text: string;
  readonly report_id: string | null;
  readonly created_at: string;
};

export type IpBlockRow = {
  readonly id: string;
  readonly ip: string;
  readonly severity: string;
  readonly comment: string;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type EmailDomainBlockRow = {
  readonly id: string;
  readonly domain: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type MarkerRow = {
  readonly id: string;
  readonly user_id: string;
  readonly timeline: string;
  readonly last_read_id: string;
  readonly version: number;
  readonly updated_at: string;
};

export type UserPreferenceRow = {
  readonly id: string;
  readonly user_id: string;
  readonly key: string;
  readonly value: string;
};

export type FilterRow = {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly context: string;
  readonly action: string;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type FilterKeywordRow = {
  readonly id: string;
  readonly filter_id: string;
  readonly keyword: string;
  readonly whole_word: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type FilterStatusRow = {
  readonly id: string;
  readonly filter_id: string;
  readonly status_id: string;
  readonly created_at: string;
};

// ============================================================
// INSTANCE SETTINGS & CONTENT
// ============================================================

export type SettingRow = {
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
};

export type CustomEmojiRow = {
  readonly id: string;
  readonly shortcode: string;
  readonly domain: string | null;
  readonly image_key: string;
  readonly visible_in_picker: number;
  readonly category: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type AnnouncementRow = {
  readonly id: string;
  readonly text: string;
  readonly published: number;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly all_day: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type RuleRow = {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly created_at: string;
  readonly updated_at: string;
};

// ============================================================
// CONVERSATIONS (DIRECT MESSAGES)
// ============================================================

export type ConversationRow = {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type ConversationAccountRow = {
  readonly conversation_id: string;
  readonly account_id: string;
  readonly last_status_id: string | null;
  readonly unread: number;
};

// ============================================================
// JOIN ROW TYPES (SELECT s.*, a.* with aliased account columns)
// ============================================================

/**
 * Result of `SELECT s.*, a.username AS a_username, a.domain AS a_domain, ...`
 * Used by DM streaming, inbox processors, and other status+account JOINs.
 */
export type StatusWithJoinedAccountRow = StatusRow & {
  readonly a_username: string;
  readonly a_domain: string | null;
  readonly a_display_name: string;
  readonly a_note: string;
  readonly a_uri: string;
  readonly a_url: string | null;
  readonly a_avatar_url: string | null;
  readonly a_avatar_static_url: string | null;
  readonly a_header_url: string | null;
  readonly a_header_static_url: string | null;
  readonly a_locked: number;
  readonly a_bot: number;
  readonly a_discoverable: number | null;
  readonly a_followers_count: number;
  readonly a_following_count: number;
  readonly a_statuses_count: number;
  readonly a_created_at: string;
  readonly a_last_status_at?: string | null;
  readonly a_emoji_tags?: string | null;
};

/** Result of `SELECT content, spoiler_text, sensitive, created_at, ... FROM status_edits` */
export type StatusEditRow = {
  readonly object_type: 'Note' | 'Article';
  readonly title: string;
  readonly content: string;
  readonly spoiler_text: string;
  readonly sensitive: number;
  readonly created_at: string;
  readonly media_attachments_json: string | null;
};
