/**
 * Mastodon REST API Base Types
 *
 * Shared type definitions for Mastodon API entities that are identical
 * between the server (worker) and frontend (Vue) sides.
 *
 * Each side extends these with additional fields specific to their needs.
 * See:
 *   - siliconbeest/server/worker/types/mastodon.ts (server extensions)
 *   - siliconbeest/src/types/mastodon.ts (frontend extensions)
 *   - https://docs.joinmastodon.org/entities/
 */

// ============================================================
// PROFILE FIELDS
// ============================================================

/** Profile metadata field (e.g., "Website", "Pronouns") */
export interface AccountField {
	name: string;
	value: string;
	verified_at: string | null;
}

// ============================================================
// EMOJI
// ============================================================

/** Custom emoji available on the instance */
export interface CustomEmoji {
	shortcode: string;
	url: string;
	static_url: string;
	visible_in_picker: boolean;
	category?: string;
}

// ============================================================
// POLL
// ============================================================

export interface PollOption {
	title: string;
	votes_count: number | null;
}

// ============================================================
// TAG
// ============================================================

export interface TagHistory {
	day: string;
	uses: string;
	accounts: string;
}

export interface BaseTag {
	name: string;
	url: string;
	history?: TagHistory[];
}

// ============================================================
// FILTER
// ============================================================

export type FilterContext = 'home' | 'notifications' | 'public' | 'thread' | 'account';

export interface FilterKeyword {
	id: string;
	keyword: string;
	whole_word: boolean;
}

export interface FilterStatus {
	id: string;
	status_id: string;
}

// ============================================================
// NOTIFICATION
// ============================================================

export type NotificationType =
	| 'mention'
	| 'status'
	| 'reblog'
	| 'follow'
	| 'follow_request'
	| 'favourite'
	| 'poll'
	| 'update'
	| 'admin.sign_up'
	| 'admin.report'
	| 'emoji_reaction';

// ============================================================
// TOKEN
// ============================================================

export interface Token {
	access_token: string;
	token_type: string;
	scope: string;
	created_at: number;
}

// ============================================================
// LIST
// ============================================================

export interface List {
	id: string;
	title: string;
	replies_policy: 'followed' | 'list' | 'none';
	exclusive?: boolean;
}

// ============================================================
// CONVERSATION
// ============================================================

/**
 * Base conversation fields shared by both sides.
 * Each side extends with its own Account/Status types.
 */
export interface BaseConversation {
	id: string;
	unread: boolean;
}

// ============================================================
// RELATIONSHIP
// ============================================================

export interface Relationship {
	id: string;
	following: boolean;
	showing_reblogs: boolean;
	notifying: boolean;
	followed_by: boolean;
	blocking: boolean;
	blocked_by: boolean;
	muting: boolean;
	muting_notifications: boolean;
	requested: boolean;
	requested_by: boolean;
	domain_blocking: boolean;
	endorsed: boolean;
	note: string;
	languages: string[] | null;
}
