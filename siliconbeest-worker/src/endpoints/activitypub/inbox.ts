import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import type { APActivity } from '../../types/activitypub';
import {
	verifySignature,
	verifySignatureRFC9421,
	extractKeyIdFromSignatureInput,
} from '../../federation/httpSignatures';
import { verifyLDSignature } from '../../federation/ldSignatures';
import { verifyProof } from '../../federation/integrityProofs';
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
 * Returns true if valid, false otherwise.
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

app.post('/:username/inbox', async (c) => {
	// Validate Content-Type
	const contentType = c.req.header('content-type') || '';
	if (!contentType.includes('application/activity+json') &&
	    !contentType.includes('application/ld+json') &&
	    !contentType.includes('application/json')) {
		return c.json({ error: 'Unsupported content type' }, 415);
	}

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

	// Verify HTTP Signature (RFC 9421 or draft-cavage), fall back to LD signature
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

	// Additionally verify Object Integrity Proof if present (FEP-8b32)
	// This is an ADDITIONAL verification, not a replacement for HTTP sig
	if (activity.proof) {
		try {
			const proof = activity.proof as { verificationMethod?: string };
			if (proof.verificationMethod) {
				// Fetch the actor document to get the Ed25519 public key
				const actorUri = (typeof activity.actor === 'string' ? activity.actor : (activity.actor as any)?.id) ?? '';
				const actorResponse = await fetch(actorUri, {
					headers: { Accept: 'application/activity+json, application/ld+json' },
				});
				if (actorResponse.ok) {
					const actorDoc = await actorResponse.json() as {
						assertionMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
					};
					if (actorDoc.assertionMethod && Array.isArray(actorDoc.assertionMethod)) {
						const keyEntry = actorDoc.assertionMethod.find(
							(k) => k.id === proof.verificationMethod && k.publicKeyMultibase,
						);
						if (keyEntry?.publicKeyMultibase) {
							const proofValid = await verifyProof(
								activity as unknown as Record<string, unknown>,
								keyEntry.publicKeyMultibase,
							);
							if (proofValid) {
								console.log(`[inbox] Object Integrity Proof verified for ${activity.id}`);
							} else {
								console.warn(`[inbox] Object Integrity Proof verification failed for ${activity.id}`);
							}
						}
					}
				}
			}
		} catch (err) {
			console.warn(`[inbox] Error verifying Object Integrity Proof:`, err);
		}
	}

	// Log for debugging
	console.log(`[inbox] ${username} received ${activity.type} from ${activity.actor}`);

	// Process the activity (DB UNIQUE constraints handle idempotency)
	try {
		await processInboxActivity(activity, account.id, c.env);
	} catch (err) {
		console.error(`[inbox] Error processing ${activity.type}:`, err);
	}

	return c.body(null, 202);
});

export default app;
