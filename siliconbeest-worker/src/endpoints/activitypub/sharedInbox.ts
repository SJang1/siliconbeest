import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { verifySignature } from '../../federation/httpSignatures';
import { processInboxActivity } from '../../federation/inboxProcessors';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * Fetch the public key PEM for a remote actor by resolving their
 * actor document. Returns null if the key cannot be retrieved.
 */
async function fetchActorPublicKey(
	keyId: string,
	env: Env,
): Promise<string | null> {
	const actorUri = keyId.split('#')[0];

	// Check cached keys first
	const cached = await env.DB.prepare(
		`SELECT ak.public_key FROM actor_keys ak
		 JOIN accounts a ON a.id = ak.account_id
		 WHERE a.uri = ?1 LIMIT 1`,
	)
		.bind(actorUri)
		.first<{ public_key: string }>();

	if (cached) {
		return cached.public_key;
	}

	// Fetch the actor document
	try {
		const response = await fetch(actorUri, {
			headers: {
				Accept: 'application/activity+json, application/ld+json',
			},
		});

		if (!response.ok) {
			console.warn(`[shared-inbox] Failed to fetch actor ${actorUri}: ${response.status}`);
			return null;
		}

		const actor = (await response.json()) as {
			publicKey?: { publicKeyPem?: string };
		};

		return actor.publicKey?.publicKeyPem ?? null;
	} catch (err) {
		console.error(`[shared-inbox] Error fetching actor public key:`, err);
		return null;
	}
}

/**
 * Parse the keyId from the Signature header.
 */
function extractKeyId(request: Request): string | null {
	const sigHeader = request.headers.get('Signature');
	if (!sigHeader) return null;

	const match = sigHeader.match(/keyId="([^"]*)"/);
	return match?.[1] ?? null;
}

app.post('/', async (c) => {
	// Parse the activity body
	let activity: APActivity;
	try {
		activity = await c.req.json<APActivity>();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	if (!activity.type || !activity.actor) {
		return c.json({ error: 'Invalid activity: missing type or actor' }, 400);
	}

	// Verify HTTP Signature
	const keyId = extractKeyId(c.req.raw);
	if (!keyId) {
		return c.json({ error: 'Missing HTTP Signature' }, 401);
	}

	const publicKeyPem = await fetchActorPublicKey(keyId, c.env);
	if (!publicKeyPem) {
		return c.json({ error: 'Could not retrieve actor public key' }, 401);
	}

	const isValid = await verifySignature(c.req.raw, publicKeyPem);
	if (!isValid) {
		return c.json({ error: 'Invalid HTTP Signature' }, 401);
	}

	console.log(`[shared-inbox] Received ${activity.type} from ${activity.actor}`);

	// Determine which local users this activity is addressed to
	const recipients = new Set<string>();
	const addRecipients = (field: string | string[] | undefined) => {
		if (!field) return;
		const arr = Array.isArray(field) ? field : [field];
		for (const uri of arr) {
			// Match local user URIs: https://domain/users/{username}
			const match = uri.match(
				new RegExp(`^https://${c.env.INSTANCE_DOMAIN}/users/([^/]+)$`),
			);
			if (match) recipients.add(match[1]);
		}
	};

	addRecipients(activity.to as string | string[] | undefined);
	addRecipients(activity.cc as string | string[] | undefined);

	// Also resolve followers collection URIs to find local accounts
	// Pattern: https://domain/users/{username}/followers
	const followerCollectionOwners = new Set<string>();
	const checkFollowersCollections = (field: string | string[] | undefined) => {
		if (!field) return;
		const arr = Array.isArray(field) ? field : [field];
		for (const uri of arr) {
			const match = uri.match(
				new RegExp(`^https://${c.env.INSTANCE_DOMAIN}/users/([^/]+)/followers$`),
			);
			if (match) followerCollectionOwners.add(match[1]);
		}
	};

	checkFollowersCollections(activity.to as string | string[] | undefined);
	checkFollowersCollections(activity.cc as string | string[] | undefined);

	// For activities addressed to followers collections, process once with
	// the collection owner as context. The processor handles fanout internally.
	if (recipients.size === 0 && followerCollectionOwners.size === 0) {
		// Activity may be a Delete, Update, or other type that doesn't need
		// specific local recipients. Process with empty account ID.
		try {
			await processInboxActivity(activity, '', c.env);
		} catch (err) {
			console.error(`[shared-inbox] Error processing ${activity.type}:`, err);
		}
		return c.body(null, 202);
	}

	// Process for explicitly addressed local users
	for (const username of recipients) {
		const account = await c.env.DB.prepare(
			`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
		)
			.bind(username)
			.first<{ id: string }>();

		if (account) {
			try {
				await processInboxActivity(activity, account.id, c.env);
			} catch (err) {
				console.error(`[shared-inbox] Error processing ${activity.type} for ${username}:`, err);
			}
		}
	}

	// Process for followers collection owners (if not already covered)
	for (const username of followerCollectionOwners) {
		if (recipients.has(username)) continue; // Already processed

		const account = await c.env.DB.prepare(
			`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
		)
			.bind(username)
			.first<{ id: string }>();

		if (account) {
			try {
				await processInboxActivity(activity, account.id, c.env);
			} catch (err) {
				console.error(`[shared-inbox] Error processing ${activity.type} for ${username}:`, err);
			}
		}
	}

	return c.body(null, 202);
});

export default app;
