/**
 * Misskey Compatibility Helpers
 *
 * Injects Misskey/Pleroma/Akkoma vendor extensions into
 * Fedify-serialized ActivityPub JSON-LD objects.
 *
 * Fedify's vocabulary types don't natively support `_misskey_*` fields,
 * so we inject them after serialization (via `toJsonLd()`).
 *
 * Extensions supported:
 * - _misskey_content: Raw markdown/MFM text (for Misskey Flavored Markdown rendering)
 * - _misskey_summary: Content warning text in MFM
 * - _misskey_quote: Quote post URI (Misskey-style)
 * - _misskey_reaction: Emoji reaction content (used in Like activities)
 *
 * See also:
 * - FEP-e232 for quote post interoperability (quoteUri field)
 * - statuses/create.ts and edit.ts for outbound Notes (now using Fedify vocab)
 * - activityBuilder.ts for buildEmojiReactActivity usage
 * - inboxProcessors/create.ts for inbound _misskey_content fallback
 * - inboxProcessors/emojiReact.ts for inbound _misskey_reaction handling
 */

// ============================================================
// OUTBOUND: Inject extensions into serialized JSON-LD
// ============================================================

export interface MisskeyNoteExtensions {
	/** Original text before HTML conversion (MFM source) -> _misskey_content */
	rawText?: string;
	/** Content warning text -> _misskey_summary */
	contentWarning?: string;
	/** Quote post URI -> _misskey_quote + quoteUri (FEP-e232) */
	quoteUri?: string;
}

/**
 * Inject Misskey vendor extensions into a Note JSON-LD object.
 *
 * Call this after `note.toJsonLd()` to add _misskey_* fields that
 * Misskey, Pleroma, and Akkoma clients expect.
 *
 * @param noteJsonLd - The JSON-LD object from Fedify's toJsonLd()
 * @param options - Which extensions to inject
 * @returns A new object with the extensions merged in
 */
export function injectMisskeyNoteExtensions(
	noteJsonLd: Record<string, unknown>,
	options: MisskeyNoteExtensions,
): Record<string, unknown> {
	const result = { ...noteJsonLd };

	if (options.rawText) {
		result._misskey_content = options.rawText;
	}
	if (options.contentWarning) {
		result._misskey_summary = options.contentWarning;
	}
	if (options.quoteUri) {
		result._misskey_quote = options.quoteUri;
		// Also add quoteUri for FEP-e232 compatibility
		result.quoteUri = options.quoteUri;
	}

	return result;
}

/**
 * Inject Misskey reaction extension into a Like activity JSON-LD object.
 *
 * Misskey uses Like activities with `_misskey_reaction` and `content` fields
 * to represent emoji reactions. This transforms a standard Fedify Like
 * into a Misskey-compatible emoji reaction.
 *
 * @param likeJsonLd - The JSON-LD object from Fedify's toJsonLd()
 * @param emoji - The emoji string (Unicode emoji or custom emoji shortcode)
 * @returns A new object with the reaction fields merged in
 */
export function injectMisskeyReaction(
	likeJsonLd: Record<string, unknown>,
	emoji: string,
): Record<string, unknown> {
	const result = { ...likeJsonLd };
	result._misskey_reaction = emoji;
	result.content = emoji;
	return result;
}

// ============================================================
// INBOUND: Extract extensions from incoming activities
// ============================================================

export interface ExtractedMisskeyExtensions {
	/** MFM source text from _misskey_content */
	misskeyContent?: string;
	/** Content warning from _misskey_summary */
	misskeySummary?: string;
	/** Quote post URI from _misskey_quote or quoteUri (FEP-e232) */
	misskeyQuote?: string;
	/** Emoji reaction from _misskey_reaction */
	misskeyReaction?: string;
}

/**
 * Extract Misskey vendor extensions from an incoming ActivityPub activity.
 *
 * Handles both Misskey-specific fields and FEP-e232 quoteUri for
 * maximum interoperability with Misskey, Pleroma, Akkoma, and other
 * fediverse implementations.
 *
 * @param activity - The raw parsed activity object (from inbox)
 * @returns An object with any found Misskey extensions
 */
export function extractMisskeyExtensions(
	activity: Record<string, unknown>,
): ExtractedMisskeyExtensions {
	const result: ExtractedMisskeyExtensions = {};

	if (typeof activity._misskey_content === 'string' && activity._misskey_content) {
		result.misskeyContent = activity._misskey_content;
	}
	if (typeof activity._misskey_summary === 'string' && activity._misskey_summary) {
		result.misskeySummary = activity._misskey_summary;
	}

	// Check both _misskey_quote and FEP-e232 quoteUri
	const quoteUri = activity._misskey_quote || activity.quoteUri;
	if (typeof quoteUri === 'string' && quoteUri) {
		result.misskeyQuote = quoteUri;
	}

	if (typeof activity._misskey_reaction === 'string' && activity._misskey_reaction) {
		result.misskeyReaction = activity._misskey_reaction;
	}

	return result;
}

/**
 * Check if a Like activity is actually a Misskey-style emoji reaction.
 *
 * Misskey sends emoji reactions as Like activities with either
 * `_misskey_reaction` or `content` fields set to the emoji.
 * This mirrors the logic in inboxProcessors/index.ts.
 *
 * @param activity - The raw parsed activity object
 * @returns true if this Like should be treated as an emoji reaction
 */
export function isEmojiReaction(activity: Record<string, unknown>): boolean {
	if (activity.type === 'EmojiReact') return true;
	if (activity.type !== 'Like') return false;
	return (
		(typeof activity._misskey_reaction === 'string' && activity._misskey_reaction !== '') ||
		(typeof activity.content === 'string' && activity.content !== '')
	);
}
