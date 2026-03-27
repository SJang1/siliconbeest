/**
 * Activity Adapter
 *
 * Converts Fedify typed activity objects to the existing APActivity format
 * used by all 13 inbox processors in src/federation/inboxProcessors/.
 *
 * When Fedify receives an activity through its inbox listener, it provides
 * typed objects (e.g., Create, Follow, Like). The existing inbox processors
 * expect the raw APActivity interface from src/types/activitypub.ts.
 *
 * This adapter bridges the gap by:
 * 1. Taking a Fedify activity's JSON-LD output
 * 2. Flattening/normalizing it to match the APActivity interface
 * 3. Preserving vendor extensions (_misskey_* fields, etc.)
 */

import type { APActivity, APObject } from '../../types/activitypub';

// ============================================================
// JSON-LD NORMALIZATION
// ============================================================

/**
 * Normalize a JSON-LD value that may be wrapped in an array (as is common
 * in expanded JSON-LD) into a scalar string or undefined.
 *
 * JSON-LD expansion often wraps values like:
 *   `"actor": [{ "@id": "https://..." }]` or `"actor": ["https://..."]`
 *
 * This extracts the first string value or @id.
 */
function normalizeToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		const first = value[0];
		if (typeof first === 'string') return first;
		if (first && typeof first === 'object' && '@id' in first) {
			return (first as Record<string, unknown>)['@id'] as string;
		}
		if (first && typeof first === 'object' && '@value' in first) {
			return (first as Record<string, unknown>)['@value'] as string;
		}
	}
	if (value && typeof value === 'object' && '@id' in value) {
		return (value as Record<string, unknown>)['@id'] as string;
	}
	return undefined;
}

/**
 * Normalize a JSON-LD value to a string array.
 * Handles both single values and arrays, and unwraps @id / @value wrappers.
 */
function normalizeToStringArray(value: unknown): string[] | undefined {
	if (!value) return undefined;
	const arr = Array.isArray(value) ? value : [value];
	const result: string[] = [];
	for (const item of arr) {
		const str = normalizeToString(item);
		if (str) result.push(str);
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Normalize a JSON-LD object value. If it's a string (bare URI reference),
 * return it as-is. If it's an object, recursively normalize known fields.
 * If it's an array, normalize the first element (for single-object fields).
 */
function normalizeObjectValue(value: unknown): string | APObject | Record<string, unknown> | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return undefined;
		// If all elements are strings or objects with @id, this might be a multi-object
		if (value.length === 1) return normalizeObjectValue(value[0]);
		// Multiple objects: return as-is for processors that handle arrays
		return value as unknown as Record<string, unknown>;
	}
	if (value && typeof value === 'object') {
		return value as Record<string, unknown>;
	}
	return undefined;
}

// ============================================================
// ADAPTER
// ============================================================

/**
 * Convert a raw JSON-LD object (from Fedify's `toJsonLd()` or from
 * direct inbox parsing) into the APActivity shape expected by
 * the inbox processors.
 *
 * This handles:
 * - Unwrapping JSON-LD expanded forms (arrays of objects with @id/@value)
 * - Preserving vendor extensions (_misskey_*, quoteUri, etc.)
 * - Normalizing `to`/`cc` to string arrays
 * - Ensuring `actor` is a string
 * - Passing through `object` as-is (string URI or nested object)
 *
 * @param jsonLd - The raw JSON-LD activity object
 * @returns An APActivity-compatible object for the inbox dispatcher
 */
export function adaptJsonLdToAPActivity(
	jsonLd: Record<string, unknown>,
): APActivity {
	const activity: Record<string, unknown> = {};

	// Copy @context as-is
	if (jsonLd['@context']) {
		activity['@context'] = jsonLd['@context'];
	}

	// id
	activity.id = normalizeToString(jsonLd.id ?? jsonLd['@id']);

	// type — Fedify may use full URI or compact form
	const rawType = jsonLd.type ?? jsonLd['@type'];
	if (typeof rawType === 'string') {
		activity.type = extractLocalName(rawType);
	} else if (Array.isArray(rawType) && rawType.length > 0) {
		activity.type = extractLocalName(String(rawType[0]));
	}

	// actor
	activity.actor = normalizeToString(jsonLd.actor) ?? '';

	// object — can be a string URI, a nested object, or an array
	const obj = jsonLd.object;
	if (obj !== undefined) {
		activity.object = normalizeObjectValue(obj);
	}

	// target
	if (jsonLd.target !== undefined) {
		activity.target = normalizeObjectValue(jsonLd.target);
	}

	// to / cc
	const to = normalizeToStringArray(jsonLd.to);
	if (to) activity.to = to;
	const cc = normalizeToStringArray(jsonLd.cc);
	if (cc) activity.cc = cc;

	// published
	const published = normalizeToString(jsonLd.published);
	if (published) activity.published = published;

	// content (used by EmojiReact/Like with emoji, and Flag)
	if (typeof jsonLd.content === 'string') {
		activity.content = jsonLd.content;
	}

	// signature / proof — pass through as-is
	if (jsonLd.signature) activity.signature = jsonLd.signature;
	if (jsonLd.proof) activity.proof = jsonLd.proof;

	// Preserve vendor extensions (_misskey_*, quoteUri, etc.)
	for (const key of Object.keys(jsonLd)) {
		if (key.startsWith('_misskey_') || key === 'quoteUri') {
			activity[key] = jsonLd[key];
		}
	}

	// Preserve tag array for emoji reactions and other processors
	if (jsonLd.tag) {
		activity.tag = jsonLd.tag;
	}

	return activity as unknown as APActivity;
}

/**
 * Extract the local name from a possibly full IRI type.
 * e.g., "https://www.w3.org/ns/activitystreams#Create" -> "Create"
 *       "Create" -> "Create"
 */
function extractLocalName(typeStr: string): string {
	const hashIdx = typeStr.lastIndexOf('#');
	if (hashIdx !== -1) return typeStr.slice(hashIdx + 1);
	const slashIdx = typeStr.lastIndexOf('/');
	if (slashIdx !== -1) return typeStr.slice(slashIdx + 1);
	return typeStr;
}
