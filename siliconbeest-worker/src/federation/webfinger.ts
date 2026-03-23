/**
 * WebFinger Resolution & Remote Actor Fetching
 *
 * Implements RFC 7033 WebFinger resolution and remote actor
 * fetching with optional KV-based caching for Cloudflare Workers.
 */

const WEBFINGER_CACHE_TTL = 86400; // 24 hours in seconds
const ACTOR_CACHE_TTL = 86400; // 24 hours in seconds

// ============================================================
// WEBFINGER
// ============================================================

export interface WebFingerResult {
	actorUri: string;
	profileUrl?: string;
}

/**
 * Resolve a WebFinger acct URI to an ActivityPub actor URI.
 *
 * Accepts formats:
 *   - user@domain
 *   - acct:user@domain
 *   - @user@domain
 *
 * @param acct - The account identifier to resolve
 * @param cache - Optional KV namespace for caching results
 * @returns The resolved actor URI and optional profile URL, or null on failure
 */
export async function resolveWebFinger(
	acct: string,
	cache?: KVNamespace,
): Promise<WebFingerResult | null> {
	// Normalize the acct string
	let normalized = acct.trim();
	if (normalized.startsWith('@')) {
		normalized = normalized.slice(1);
	}
	if (normalized.startsWith('acct:')) {
		normalized = normalized.slice(5);
	}

	const atIndex = normalized.indexOf('@');
	if (atIndex === -1) {
		return null;
	}

	const user = normalized.slice(0, atIndex);
	const domain = normalized.slice(atIndex + 1);

	if (!user || !domain) {
		return null;
	}

	const resource = `acct:${user}@${domain}`;
	const cacheKey = `webfinger:${resource}`;

	// Check cache first
	if (cache) {
		const cached = await cache.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached) as WebFingerResult;
			} catch {
				// Invalid cache entry, fall through
			}
		}
	}

	// Fetch WebFinger
	const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

	let response: Response;
	try {
		response = await fetch(webfingerUrl, {
			headers: {
				Accept: 'application/jrd+json, application/json',
			},
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		return null;
	}

	let data: {
		links?: Array<{
			rel: string;
			type?: string;
			href?: string;
		}>;
	};

	try {
		data = await response.json();
	} catch {
		return null;
	}

	if (!data.links || !Array.isArray(data.links)) {
		return null;
	}

	// Find the self link with ActivityPub content type
	const selfLink = data.links.find(
		(link) =>
			link.rel === 'self' &&
			(link.type === 'application/activity+json' ||
				link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
			link.href,
	);

	if (!selfLink?.href) {
		return null;
	}

	// Find the profile URL (optional)
	const profileLink = data.links.find(
		(link) =>
			link.rel === 'http://webfinger.net/rel/profile-page' &&
			link.type === 'text/html' &&
			link.href,
	);

	const result: WebFingerResult = {
		actorUri: selfLink.href,
		profileUrl: profileLink?.href,
	};

	// Cache the result
	if (cache) {
		await cache.put(cacheKey, JSON.stringify(result), {
			expirationTtl: WEBFINGER_CACHE_TTL,
		});
	}

	return result;
}

// ============================================================
// REMOTE ACTOR FETCHING
// ============================================================

/**
 * Fetch a remote ActivityPub actor document by its URI.
 *
 * @param actorUri - The full URI of the remote actor
 * @param cache - Optional KV namespace for caching results
 * @returns The parsed actor JSON, or null on failure
 */
export async function fetchRemoteActor(
	actorUri: string,
	cache?: KVNamespace,
): Promise<any | null> {
	const cacheKey = `remote_actor:${actorUri}`;

	// Check cache first
	if (cache) {
		const cached = await cache.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached);
			} catch {
				// Invalid cache entry, fall through
			}
		}
	}

	let response: Response;
	try {
		response = await fetch(actorUri, {
			headers: {
				Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
			},
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		return null;
	}

	let actor: any;
	try {
		actor = await response.json();
	} catch {
		return null;
	}

	// Basic validation: must have an id and type
	if (!actor || !actor.id || !actor.type) {
		return null;
	}

	// Cache the result
	if (cache) {
		await cache.put(cacheKey, JSON.stringify(actor), {
			expirationTtl: ACTOR_CACHE_TTL,
		});
	}

	return actor;
}
