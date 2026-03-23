/**
 * Content parser for Mastodon-compatible status text.
 * Converts plain text with @mentions, #hashtags, and URLs into HTML.
 */

export interface ParsedMention {
	username: string;
	domain: string | null;
	acct: string;
}

export interface ParsedContent {
	html: string;
	mentions: ParsedMention[];
	tags: string[];
}

/**
 * Parse status text into HTML with linked mentions, hashtags, and URLs.
 *
 * @param text - The raw status text.
 * @param domain - The local domain (for resolving local mentions).
 * @returns Parsed content with HTML, mentions list, and tags list.
 */
export function parseContent(text: string, domain: string): ParsedContent {
	const mentions: ParsedMention[] = [];
	const tags: string[] = [];

	// Split into paragraphs by double newlines
	const paragraphs = text.split(/\n{2,}/);

	const htmlParagraphs = paragraphs.map((paragraph) => {
		let processed = escapeHtml(paragraph);

		// Replace single newlines with <br />
		processed = processed.replace(/\n/g, '<br />');

		// Process URLs first (before mentions/hashtags to avoid conflicts)
		processed = processUrls(processed);

		// Process @user@domain mentions (federated)
		processed = processMentions(processed, domain, mentions);

		// Process #hashtags
		processed = processHashtags(processed, tags);

		return `<p>${processed}</p>`;
	});

	const html = htmlParagraphs.join('');

	return { html, mentions, tags };
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');
}

/**
 * Detect and linkify URLs in text.
 */
function processUrls(text: string): string {
	// Match URLs starting with http:// or https://
	const urlRegex = /https?:\/\/[^\s<>&"')\]]+/g;

	return text.replace(urlRegex, (url) => {
		// Clean trailing punctuation that's likely not part of the URL
		let cleanUrl = url;
		const trailingPunctuation = /[.,;:!?)]+$/;
		const trailingMatch = cleanUrl.match(trailingPunctuation);
		let trailing = '';
		if (trailingMatch) {
			trailing = trailingMatch[0];
			cleanUrl = cleanUrl.slice(0, -trailing.length);
		}

		return `<a href="${cleanUrl}" rel="noopener noreferrer" target="_blank">${cleanUrl}</a>${trailing}`;
	});
}

/**
 * Detect and linkify @mentions in text.
 * Handles both @user@domain (federated) and @user (local) forms.
 */
function processMentions(text: string, localDomain: string, mentions: ParsedMention[]): string {
	// Match @user@domain or @user (must be preceded by start-of-string or whitespace/punctuation)
	const mentionRegex = /(?:^|[\s>,.;:!?()])@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))?/g;

	return text.replace(mentionRegex, (match, username: string, mentionDomain: string | undefined) => {
		const domain = mentionDomain || null;
		const acct = domain ? `${username}@${domain}` : username;
		const targetDomain = domain || localDomain;

		// Add to mentions list if not already present
		const alreadyExists = mentions.some((m) => m.acct === acct);
		if (!alreadyExists) {
			mentions.push({ username, domain, acct });
		}

		const profileUrl = `https://${targetDomain}/@${username}`;
		return `<a href="${profileUrl}" class="mention">@${username}</a>`;
	});
}

/**
 * Detect and linkify #hashtags in text.
 */
function processHashtags(text: string, tags: string[]): string {
	// Match #hashtag (word characters and underscores, must start with a letter)
	const hashtagRegex = /(?:^|[\s>,.;:!?()])#([a-zA-Z][a-zA-Z0-9_]*)/g;

	return text.replace(hashtagRegex, (match, tag: string) => {
		const normalizedTag = tag.toLowerCase();

		if (!tags.includes(normalizedTag)) {
			tags.push(normalizedTag);
		}

		return `<a href="/tags/${normalizedTag}" class="hashtag">#${tag}</a>`;
	});
}
