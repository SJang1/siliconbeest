/**
 * Allowlist-based HTML sanitizer for Cloudflare Workers (no DOM/DOMParser).
 * Uses regex-based approach to strip disallowed tags, attributes, and dangerous content.
 */

/* oxlint-disable fp/no-let, fp/no-loop-statements */

const ALLOWED_TAGS = new Set([
	'p',
	'br',
	'a',
	'span',
	'strong',
	'em',
	'del',
	'blockquote',
	'pre',
	'code',
	'ul',
	'ol',
	'li',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
]);

// FEP-b2b8 recommends this additional sanitized HTML subset for long-form
// Article bodies. Keep it Article-specific so regular microblog posts retain
// their narrower rendering surface.
const ARTICLE_ALLOWED_TAGS = new Set([
	...ALLOWED_TAGS,
	'b',
	'i',
	'u',
	'img',
	'video',
	'audio',
	'source',
	'ruby',
	'rt',
	'rp',
]);

/** Attributes allowed per tag. `*` means the attribute is allowed on any tag. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(['href', 'rel', 'target']),
	'*': new Set(['class']),
};

const ARTICLE_ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
	...ALLOWED_ATTRIBUTES,
	img: new Set(['src', 'alt', 'title', 'width', 'height']),
	video: new Set(['src', 'controls', 'loop', 'poster', 'width', 'height']),
	audio: new Set(['src', 'controls', 'loop']),
	source: new Set(['src', 'type']),
	ol: new Set(['start', 'reversed']),
	li: new Set(['value']),
};

/**
 * Sanitize HTML by stripping disallowed tags, attributes, and dangerous content.
 * Only allows a safe subset of HTML elements and attributes.
 */
export function sanitizeHtml(html: string): string {
	return sanitizeWithRules(html, ALLOWED_TAGS, ALLOWED_ATTRIBUTES);
}

/** Sanitize the richer embedded-media HTML subset recommended by FEP-b2b8. */
export function sanitizeArticleHtml(html: string): string {
	return sanitizeWithRules(html, ARTICLE_ALLOWED_TAGS, ARTICLE_ALLOWED_ATTRIBUTES);
}

function sanitizeWithRules(
	html: string,
	allowedTags: ReadonlySet<string>,
	allowedAttributes: Readonly<Record<string, Set<string>>>,
): string {
	if (!html) return '';

	let result = html;

	// 1. Remove <script> and <style> blocks entirely (including content)
	result = result.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
	result = result.replace(/<style[\s\S]*?<\/style\s*>/gi, '');

	// 2. Remove HTML comments
	result = result.replace(/<!--[\s\S]*?-->/g, '');

	// 3. Process all HTML tags
	result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\s*\/?>/g, (match, tagName: string, attrs: string) => {
		const tag = tagName.toLowerCase();

		// Remove disallowed tags entirely (keep inner content by stripping the tag itself)
		if (!allowedTags.has(tag)) {
			return '';
		}

		// Self-closing tag (like <br /> or <br>)
		const isClosing = match.startsWith('</');
		const isSelfClosing = tag === 'br' || tag === 'img' || tag === 'source';

		if (isClosing && isSelfClosing) {
			return '';
		}

		if (isClosing) {
			return `</${tag}>`;
		}

		// Sanitize attributes
		const cleanAttrs = sanitizeAttributes(tag, attrs || '', allowedAttributes);

		if (isSelfClosing) {
			return cleanAttrs ? `<${tag} ${cleanAttrs} />` : `<${tag} />`;
		}

		return cleanAttrs ? `<${tag} ${cleanAttrs}>` : `<${tag}>`;
	});

	return result;
}

/** Strip markup from a value that is stored and rendered as plain text. */
export function sanitizePlainText(value: string): string {
	if (!value) return '';
	return value
		.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
		.replace(/<style[\s\S]*?<\/style\s*>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[a-zA-Z/][^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Sanitize attributes for a given tag, keeping only allowed ones.
 */
function sanitizeAttributes(
	tag: string,
	attrsString: string,
	allowedAttributes: Readonly<Record<string, Set<string>>>,
): string {
	if (!attrsString.trim()) return '';

	const tagAllowed = allowedAttributes[tag] || new Set();
	const globalAllowed = allowedAttributes['*'] || new Set();

	const attrs: string[] = [];

	// Match attribute patterns: name="value", name='value', name=value, or standalone name
	const attrRegex = /([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
	let attrMatch;

	while ((attrMatch = attrRegex.exec(attrsString)) !== null) {
		const attrName = attrMatch[1].toLowerCase();
		const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

		// Skip event handler attributes (onclick, onload, etc.)
		if (attrName.startsWith('on')) {
			continue;
		}

		// Skip data- attributes
		if (attrName.startsWith('data-')) {
			continue;
		}

		// Check if this attribute is allowed for this tag or globally
		if (!tagAllowed.has(attrName) && !globalAllowed.has(attrName)) {
			continue;
		}

		// Special validation for href attribute
		if (attrName === 'href') {
			const sanitizedHref = sanitizeHref(attrValue);
			if (sanitizedHref === null) {
				continue;
			}
			attrs.push(`${attrName}="${escapeAttrValue(sanitizedHref)}"`);
			continue;
		}

		if (attrName === 'src' || attrName === 'poster') {
			const sanitizedUrl = sanitizeMediaUrl(attrValue);
			if (sanitizedUrl === null) continue;
			attrs.push(`${attrName}="${escapeAttrValue(sanitizedUrl)}"`);
			continue;
		}

		if (attrName === 'width' || attrName === 'height' || attrName === 'start' || attrName === 'value') {
			if (!/^\d+$/.test(attrValue)) continue;
		}

		attrs.push(`${attrName}="${escapeAttrValue(attrValue)}"`);
	}

	return attrs.join(' ');
}

/** Embedded media is limited to absolute HTTP(S) resources. */
function sanitizeMediaUrl(value: string): string | null {
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();
	return lower.startsWith('https://') || lower.startsWith('http://') ? trimmed : null;
}

/**
 * Validate and sanitize href attribute values.
 * Only allows http:// and https:// URLs.
 * Returns null if the href is not safe.
 */
function sanitizeHref(href: string): string | null {
	const trimmed = href.trim().toLowerCase();

	// Block javascript:, data:, vbscript:, and other dangerous protocols
	if (
		trimmed.startsWith('javascript:') ||
		trimmed.startsWith('data:') ||
		trimmed.startsWith('vbscript:') ||
		trimmed.startsWith('blob:')
	) {
		return null;
	}

	// Allow http, https, mailto, and relative URLs
	if (
		trimmed.startsWith('http://') ||
		trimmed.startsWith('https://') ||
		trimmed.startsWith('mailto:') ||
		trimmed.startsWith('/') ||
		trimmed.startsWith('#')
	) {
		return href.trim();
	}

	// Block everything else that contains a colon (potential protocol)
	if (trimmed.includes(':')) {
		return null;
	}

	// Allow relative URLs without protocol
	return href.trim();
}

/**
 * Escape special characters in HTML attribute values.
 */
function escapeAttrValue(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
