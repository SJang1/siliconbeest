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
	// keyId is typically "{actorUri}#main-key"; derive the actor URI
	const actorUri = keyId.split('#')[0];

	// Check if we already have the key cached in our accounts table
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

	// Fetch the actor document to get the public key
	try {
		const response = await fetch(actorUri, {
			headers: {
				Accept: 'application/activity+json, application/ld+json',
			},
		});

		if (!response.ok) {
			console.warn(`[inbox] Failed to fetch actor ${actorUri}: ${response.status}`);
			return null;
		}

		const actor = (await response.json()) as {
			publicKey?: { publicKeyPem?: string };
		};

		return actor.publicKey?.publicKeyPem ?? null;
	} catch (err) {
		console.error(`[inbox] Error fetching actor public key:`, err);
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

app.post('/:username/inbox', async (c) => {
	const username = c.req.param('username');

	// Verify the target user exists locally
	const account = await c.env.DB.prepare(
		`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(username)
		.first<{ id: string }>();

	if (!account) {
		return c.json({ error: 'Record not found' }, 404);
	}

	// Parse the activity body (before signature verification so we can
	// reference it, but clone the request for verification)
	const rawBody = await c.req.text();
	let activity: APActivity;
	try {
		activity = JSON.parse(rawBody) as APActivity;
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

	const isValid = await verifySignature(c.req.raw, publicKeyPem, rawBody);
	if (!isValid) {
		return c.json({ error: 'Invalid HTTP Signature' }, 401);
	}

	// Log for debugging
	console.log(`[inbox] ${username} received ${activity.type} from ${activity.actor}`);

	// Process the activity
	try {
		await processInboxActivity(activity, account.id, c.env);
	} catch (err) {
		console.error(`[inbox] Error processing ${activity.type}:`, err);
	}

	return c.body(null, 202);
});

export default app;
