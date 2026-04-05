/**
 * JSON-LD Normalization Utilities for ActivityPub
 *
 * Pure functions that normalize JSON-LD quirks (arrays, @id/@value wrappers,
 * namespace-prefixed types) into plain JavaScript values suitable for
 * ActivityPub processing.
 *
 * These have ZERO external dependencies — no Fedify, no Cloudflare bindings.
 */

export function normalizeToString(value: unknown): string | undefined {
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

export function normalizeToStringArray(value: unknown): string[] | undefined {
	if (!value) return undefined;
	const arr = Array.isArray(value) ? value : [value];
	const result: string[] = [];
	for (const item of arr) {
		const str = normalizeToString(item);
		if (str) result.push(str);
	}
	return result.length > 0 ? result : undefined;
}

export function normalizeObjectValue(
	value: unknown,
): string | Record<string, unknown> | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return undefined;
		if (value.length === 1) return normalizeObjectValue(value[0]);
		return value as unknown as Record<string, unknown>;
	}
	if (value && typeof value === 'object') {
		return value as Record<string, unknown>;
	}
	return undefined;
}

export function extractLocalName(typeStr: string): string {
	const hashIdx = typeStr.lastIndexOf('#');
	if (hashIdx !== -1) return typeStr.slice(hashIdx + 1);
	const slashIdx = typeStr.lastIndexOf('/');
	if (slashIdx !== -1) return typeStr.slice(slashIdx + 1);
	return typeStr;
}

/**
 * Build a normalized activity object from raw JSON-LD.
 *
 * Handles JSON-LD quirks (arrays, @id wrappers, namespace-prefixed types)
 * and preserves vendor extensions (Misskey, quoteUri).
 */
export function buildActivityFromJsonLd(
	jsonLd: Record<string, unknown>,
): Record<string, unknown> {
	const activity: Record<string, unknown> = {};

	if (jsonLd['@context']) activity['@context'] = jsonLd['@context'];

	activity.id = normalizeToString(jsonLd.id ?? jsonLd['@id']);

	const rawType = jsonLd.type ?? jsonLd['@type'];
	if (typeof rawType === 'string') {
		activity.type = extractLocalName(rawType);
	} else if (Array.isArray(rawType) && rawType.length > 0) {
		activity.type = extractLocalName(String(rawType[0]));
	}

	activity.actor = normalizeToString(jsonLd.actor) ?? '';

	if (jsonLd.object !== undefined) {
		activity.object = normalizeObjectValue(jsonLd.object);
	}
	if (jsonLd.target !== undefined) {
		activity.target = normalizeObjectValue(jsonLd.target);
	}

	const to = normalizeToStringArray(jsonLd.to);
	if (to) activity.to = to;
	const cc = normalizeToStringArray(jsonLd.cc);
	if (cc) activity.cc = cc;

	if (typeof jsonLd.published === 'string') activity.published = jsonLd.published;
	if (typeof jsonLd.content === 'string') activity.content = jsonLd.content;

	if (jsonLd.signature) activity.signature = jsonLd.signature;
	if (jsonLd.proof) activity.proof = jsonLd.proof;
	if (jsonLd.tag) activity.tag = jsonLd.tag;

	// Preserve vendor extensions
	for (const key of Object.keys(jsonLd)) {
		if (key.startsWith('_misskey_') || key === 'quoteUri') {
			activity[key] = jsonLd[key];
		}
	}

	return activity;
}
