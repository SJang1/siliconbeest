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

/** Attributes allowed per tag. `*` means the attribute is allowed on any tag. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(['href', 'rel', 'target']),
	'*': new Set(['class']),
};

/**
 * Sanitize HTML by stripping disallowed tags, attributes, and dangerous content.
 * Only allows a safe subset of HTML elements and attributes.
 */
export function sanitizeHtml(html: string): string {
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
		if (!ALLOWED_TAGS.has(tag)) {
			return '';
		}

		// Self-closing tag (like <br /> or <br>)
		const isClosing = match.startsWith('</');
		const isSelfClosing = tag === 'br';

		if (isClosing) {
			return `</${tag}>`;
		}

		// Sanitize attributes
		const cleanAttrs = sanitizeAttributes(tag, attrs || '');

		if (isSelfClosing) {
			return cleanAttrs ? `<${tag} ${cleanAttrs} />` : `<${tag} />`;
		}

		return cleanAttrs ? `<${tag} ${cleanAttrs}>` : `<${tag}>`;
	});

	return result;
}

/**
 * Sanitize attributes for a given tag, keeping only allowed ones.
 */
function sanitizeAttributes(tag: string, attrsString: string): string {
	if (!attrsString.trim()) return '';

	const tagAllowed = ALLOWED_ATTRIBUTES[tag] || new Set();
	const globalAllowed = ALLOWED_ATTRIBUTES['*'] || new Set();

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

		attrs.push(`${attrName}="${escapeAttrValue(attrValue)}"`);
	}

	return attrs.join(' ');
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
