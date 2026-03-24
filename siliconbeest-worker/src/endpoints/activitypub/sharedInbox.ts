import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import type { APActivity } from '../../types/activitypub';
import {
	verifySignature,
	verifySignatureRFC9421,
	extractKeyIdFromSignatureInput,
} from '../../federation/httpSignatures';
import { verifyLDSignature } from '../../federation/ldSignatures';
import { processInboxActivity } from '../../federation/inboxProcessors';
import { maybeForwardActivity } from '../../federation/activityForwarder';

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
 * Extract the keyId from the request. Checks RFC 9421 Signature-Input
 * first, then falls back to draft-cavage Signature header.
 */
function extractKeyId(request: Request): string | null {
	// RFC 9421: keyid is in Signature-Input header
	const signatureInputHeader = request.headers.get('Signature-Input');
	if (signatureInputHeader) {
		const keyId = extractKeyIdFromSignatureInput(signatureInputHeader);
		if (keyId) return keyId;
	}

	// Draft-cavage: keyId is in the Signature header
	const sigHeader = request.headers.get('Signature');
	if (!sigHeader) return null;

	const match = sigHeader.match(/keyId="([^"]*)"/);
	return match?.[1] ?? null;
}

/**
 * Determine which signature scheme the request uses and verify accordingly.
 */
async function verifyRequestSignature(
	request: Request,
	publicKeyPem: string,
	rawBody: string,
): Promise<boolean> {
	// If Signature-Input header is present, use RFC 9421 verification
	if (request.headers.has('Signature-Input')) {
		const rfc9421Valid = await verifySignatureRFC9421(request, publicKeyPem, rawBody);
		if (rfc9421Valid) return true;
		// If RFC 9421 fails, don't fall back — the sender explicitly used RFC 9421
		return false;
	}

	// Otherwise, use draft-cavage verification
	return verifySignature(request, publicKeyPem, rawBody);
}

app.post('/', async (c) => {
	// Validate Content-Type
	const contentType = c.req.header('content-type') || '';
	if (!contentType.includes('application/activity+json') &&
	    !contentType.includes('application/ld+json') &&
	    !contentType.includes('application/json')) {
		return c.json({ error: 'Unsupported content type' }, 415);
	}

	// Parse the activity body
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

	// Verify HTTP Signature, fall back to LD signature
	const keyId = extractKeyId(c.req.raw);
	let signatureVerified = false;

	if (keyId) {
		const publicKeyPem = await fetchActorPublicKey(keyId, c.env);
		if (publicKeyPem) {
			signatureVerified = await verifyRequestSignature(c.req.raw, publicKeyPem, rawBody);
		}
	}

	// Fall back to Linked Data Signature if no HTTP signature or it failed
	if (!signatureVerified && activity.signature) {
		const ldKeyId = activity.signature.creator;
		const ldPublicKeyPem = await fetchActorPublicKey(ldKeyId, c.env);
		if (ldPublicKeyPem) {
			signatureVerified = await verifyLDSignature(activity, ldPublicKeyPem);
		}
	}

	if (!signatureVerified) {
		return c.json({ error: 'Invalid or missing signature' }, 401);
	}

	// Idempotency check: skip if we have already processed this activity
	if (activity.id) {
		const seenKey = `activity-seen:${activity.id}`;
		const seen = await c.env.CACHE.get(seenKey);
		if (seen) {
			console.log(`[shared-inbox] Duplicate activity ${activity.id}, skipping`);
			return c.body(null, 202);
		}
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

	// Track processed activity+account pairs to avoid duplicate processing
	// when an activity is addressed to multiple local users or followers collections
	const processedAccounts = new Set<string>();

	// Process for explicitly addressed local users
	for (const username of recipients) {
		const account = await c.env.DB.prepare(
			`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
		)
			.bind(username)
			.first<{ id: string }>();

		if (account && !processedAccounts.has(account.id)) {
			processedAccounts.add(account.id);
			try {
				await processInboxActivity(activity, account.id, c.env);
			} catch (err) {
				console.error(`[shared-inbox] Error processing ${activity.type} for ${username}:`, err);
			}
		}
	}

	// Process for followers collection owners (if not already covered)
	for (const username of followerCollectionOwners) {
		if (recipients.has(username)) continue; // Already processed by username

		const account = await c.env.DB.prepare(
			`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
		)
			.bind(username)
			.first<{ id: string }>();

		if (account && !processedAccounts.has(account.id)) {
			processedAccounts.add(account.id);
			try {
				await processInboxActivity(activity, account.id, c.env);
			} catch (err) {
				console.error(`[shared-inbox] Error processing ${activity.type} for ${username}:`, err);
			}
		}
	}

	// After processing, check if the activity should be forwarded
	// to other servers (signature already verified above)
	try {
		await maybeForwardActivity(activity, rawBody, c.req.raw, c.env);
	} catch (err) {
		console.error(`[shared-inbox] Error forwarding activity:`, err);
	}

	// Mark activity as seen with 24h TTL
	if (activity.id) {
		await c.env.CACHE.put(`activity-seen:${activity.id}`, '1', {
			expirationTtl: 86400,
		});
	}

	return c.body(null, 202);
});

export default app;
