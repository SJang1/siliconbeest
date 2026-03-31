/**
 * WebAuthn / Passkey authentication endpoints.
 *
 * POST /register/options    — generate registration options (authRequired)
 * POST /register/verify     — verify registration response (authRequired)
 * POST /authenticate/options — generate authentication options (no auth)
 * POST /authenticate/verify  — verify authentication response (no auth)
 * GET  /credentials          — list user's passkeys (authRequired)
 * DELETE /credentials/:id    — delete a passkey (authRequired)
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { generateUlid } from '../../../../utils/ulid';
import { sha256 } from '../../../../utils/crypto';
import { generateSecureRandom } from '../../../../utils/crypto';
import { decodeCBOR } from '../../../../utils/cbor';
import {
	base64urlEncode,
	base64urlDecode,
	parseAuthenticatorData,
	coseKeyToCryptoKey,
	verifySignature,
} from '../../../../utils/webauthn';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrigin(env: Env): string {
	return `https://${env.INSTANCE_DOMAIN}`;
}

function getRpId(env: Env): string {
	return env.INSTANCE_DOMAIN;
}

function getRpName(env: Env): string {
	return env.INSTANCE_TITLE || 'SiliconBeest';
}

// ---------------------------------------------------------------------------
// POST /register/options — Generate registration options (authRequired)
// ---------------------------------------------------------------------------

app.post('/register/options', authRequired, async (c) => {
	const user = c.get('currentUser')!;

	// Generate 32-byte random challenge
	const challenge = generateSecureRandom(32);
	const challengeB64 = base64urlEncode(challenge);

	// Store challenge in KV with 5-minute TTL
	await c.env.CACHE.put(
		`webauthn_challenge:${challengeB64}`,
		JSON.stringify({ userId: user.id, type: 'register' }),
		{ expirationTtl: 300 },
	);

	// Query existing credentials for excludeCredentials
	const existing = await c.env.DB.prepare(
		'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?1',
	)
		.bind(user.id)
		.all<{ credential_id: string; transports: string | null }>();

	const excludeCredentials = (existing.results || []).map((cred) => ({
		type: 'public-key' as const,
		id: cred.credential_id,
		transports: cred.transports ? JSON.parse(cred.transports) : undefined,
	}));

	// Get account info for user display
	const account = c.get('currentAccount')!;

	return c.json({
		rp: {
			id: getRpId(c.env),
			name: getRpName(c.env),
		},
		user: {
			id: base64urlEncode(new TextEncoder().encode(user.id)),
			name: user.email,
			displayName: account.username,
		},
		challenge: challengeB64,
		pubKeyCredParams: [
			{ type: 'public-key', alg: -7 },   // ES256
			{ type: 'public-key', alg: -257 },  // RS256
		],
		timeout: 300000,
		excludeCredentials,
		authenticatorSelection: {
			residentKey: 'preferred',
			requireResidentKey: false,
			userVerification: 'preferred',
		},
		attestation: 'none',
	});
});

// ---------------------------------------------------------------------------
// POST /register/verify — Verify registration response (authRequired)
// ---------------------------------------------------------------------------

app.post('/register/verify', authRequired, async (c) => {
  try {
	const user = c.get('currentUser')!;

	const body = await c.req.json<{
		id: string;
		rawId: string;
		type: string;
		response: {
			attestationObject: string;
			clientDataJSON: string;
		};
		name?: string;
	}>().catch(() => null);

	if (!body || !body.response) {
		return c.json({ error: 'Invalid request body' }, 422);
	}

	// 1. Decode and verify clientDataJSON
	const clientDataJSON = base64urlDecode(body.response.clientDataJSON);
	const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));

	if (clientData.type !== 'webauthn.create') {
		return c.json({ error: 'Invalid clientData type' }, 400);
	}

	if (clientData.origin !== getOrigin(c.env)) {
		return c.json({ error: 'Invalid origin' }, 400);
	}

	// 2. Verify challenge from KV
	const challengeKey = `webauthn_challenge:${clientData.challenge}`;
	const challengeData = await c.env.CACHE.get(challengeKey, 'json') as {
		userId: string;
		type: string;
	} | null;

	if (!challengeData || challengeData.type !== 'register' || challengeData.userId !== user.id) {
		return c.json({ error: 'Invalid or expired challenge' }, 400);
	}

	// Delete challenge to prevent replay
	await c.env.CACHE.delete(challengeKey);

	// 3. Decode attestationObject (CBOR)
	const attestationObjectBytes = base64urlDecode(body.response.attestationObject);
	const attestationObject = decodeCBOR(attestationObjectBytes) as Map<string, any>;

	const authData = attestationObject.get('authData') as Uint8Array;
	if (!authData) {
		return c.json({ error: 'Missing authData in attestation' }, 400);
	}

	// 4. Parse authenticator data
	const parsed = parseAuthenticatorData(authData);

	// 5. Verify RP ID hash = SHA-256(INSTANCE_DOMAIN)
	const rpIdHash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(getRpId(c.env))),
	);
	if (!arrayEqual(parsed.rpIdHash, rpIdHash)) {
		return c.json({ error: 'RP ID hash mismatch' }, 400);
	}

	// 6. Verify user presence flag
	if (!parsed.flags.up) {
		return c.json({ error: 'User presence flag not set' }, 400);
	}

	// 7. Extract credential data
	if (!parsed.attestedCredentialData) {
		return c.json({ error: 'No attested credential data' }, 400);
	}

	const { credentialId, publicKey: cosePublicKey } = parsed.attestedCredentialData;
	const credentialIdB64 = base64urlEncode(credentialId);

	// 8. Determine algorithm from COSE key
	const algorithm = cosePublicKey.get(3) as number; // COSE alg parameter

	// 9. Verify we can import the key (validates it)
	await coseKeyToCryptoKey(cosePublicKey);

	// 10. Serialize COSE public key for storage
	const publicKeyB64 = base64urlEncode(attestationObjectBytes);

	// Actually, store the COSE key map as JSON-compatible format
	const publicKeyJson = serializeCoseKey(cosePublicKey, algorithm);

	// 11. Determine device type and backup eligibility
	const flagsByte = authData[32]!;
	const backupEligible = !!(flagsByte & 0x08);
	const backupState = !!(flagsByte & 0x10);
	const deviceType = backupEligible ? 'multiDevice' : 'singleDevice';

	// 12. Store credential in DB
	const now = new Date().toISOString();
	const id = generateUlid();

	await c.env.DB.prepare(
		`INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, name, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	).bind(
		id,
		user.id,
		credentialIdB64,
		publicKeyJson,
		parsed.signCount,
		deviceType,
		backupState ? 1 : 0,
		null, // transports not provided in this flow; client can update
		body.name || null,
		now,
	).run();

	return c.json({
		id,
		credential_id: credentialIdB64,
		device_type: deviceType,
		backed_up: backupState,
		name: body.name || null,
		created_at: now,
	});
  } catch (err) {
    console.error('[webauthn/register/verify]', err);
    return c.json({ error: 'Registration verification failed', error_description: (err as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /authenticate/options — Generate authentication options (no auth)
// ---------------------------------------------------------------------------

app.post('/authenticate/options', async (c) => {
	const body = await c.req.json<{ email?: string }>().catch(() => ({} as any));

	// Generate 32-byte random challenge
	const challenge = generateSecureRandom(32);
	const challengeB64 = base64urlEncode(challenge);

	// Build KV payload
	const kvPayload: { type: string; email?: string } = { type: 'authenticate' };
	if (body.email) {
		kvPayload.email = body.email.toLowerCase().trim();
	}

	await c.env.CACHE.put(
		`webauthn_challenge:${challengeB64}`,
		JSON.stringify(kvPayload),
		{ expirationTtl: 300 },
	);

	// If email provided, look up user's credentials for allowCredentials
	let allowCredentials: Array<{ type: string; id: string; transports?: string[] }> | undefined;

	if (body.email) {
		const user = await c.env.DB.prepare(
			'SELECT id FROM users WHERE email = ?1 LIMIT 1',
		).bind(body.email.toLowerCase().trim()).first<{ id: string }>();

		if (user) {
			const creds = await c.env.DB.prepare(
				'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?1',
			).bind(user.id).all<{ credential_id: string; transports: string | null }>();

			if (creds.results && creds.results.length > 0) {
				allowCredentials = creds.results.map((cred) => ({
					type: 'public-key',
					id: cred.credential_id,
					transports: cred.transports ? JSON.parse(cred.transports) : undefined,
				}));
			}
		}
	}

	return c.json({
		challenge: challengeB64,
		timeout: 300000,
		rpId: getRpId(c.env),
		userVerification: 'preferred',
		...(allowCredentials ? { allowCredentials } : {}),
	});
});

// ---------------------------------------------------------------------------
// POST /authenticate/verify — Verify authentication response (no auth)
// ---------------------------------------------------------------------------

app.post('/authenticate/verify', async (c) => {
  try {
	const body = await c.req.json<{
		id: string;
		rawId: string;
		type: string;
		response: {
			authenticatorData: string;
			clientDataJSON: string;
			signature: string;
			userHandle?: string;
		};
	}>().catch(() => null);

	if (!body || !body.response) {
		return c.json({ error: 'Invalid request body' }, 422);
	}

	// 1. Decode and verify clientDataJSON
	const clientDataJSON = base64urlDecode(body.response.clientDataJSON);
	const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));

	if (clientData.type !== 'webauthn.get') {
		return c.json({ error: 'Invalid clientData type' }, 400);
	}

	if (clientData.origin !== getOrigin(c.env)) {
		return c.json({ error: 'Invalid origin' }, 400);
	}

	// 2. Verify challenge from KV
	const challengeKey = `webauthn_challenge:${clientData.challenge}`;
	const challengeData = await c.env.CACHE.get(challengeKey, 'json') as {
		type: string;
		email?: string;
	} | null;

	if (!challengeData || challengeData.type !== 'authenticate') {
		return c.json({ error: 'Invalid or expired challenge' }, 400);
	}

	// Delete challenge to prevent replay
	await c.env.CACHE.delete(challengeKey);

	// 3. Look up credential by credential_id
	const credentialIdB64 = body.id;
	const credRow = await c.env.DB.prepare(
		`SELECT wc.id, wc.user_id, wc.credential_id, wc.public_key, wc.counter
		 FROM webauthn_credentials wc
		 WHERE wc.credential_id = ?1
		 LIMIT 1`,
	).bind(credentialIdB64).first<{
		id: string;
		user_id: string;
		credential_id: string;
		public_key: string;
		counter: number;
	}>();

	if (!credRow) {
		return c.json({ error: 'Credential not found' }, 400);
	}

	// 4. Parse authenticator data
	const authDataBytes = base64urlDecode(body.response.authenticatorData);
	const parsed = parseAuthenticatorData(authDataBytes);

	// 5. Verify RP ID hash
	const rpIdHash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(getRpId(c.env))),
	);
	if (!arrayEqual(parsed.rpIdHash, rpIdHash)) {
		return c.json({ error: 'RP ID hash mismatch' }, 400);
	}

	// 6. Verify user presence
	if (!parsed.flags.up) {
		return c.json({ error: 'User presence flag not set' }, 400);
	}

	// 7. Import stored public key and determine algorithm
	const storedKeyData = JSON.parse(credRow.public_key) as {
		algorithm: number;
		key: Record<string, string>;
	};

	const coseMap = deserializeCoseKey(storedKeyData);
	const cryptoKey = await coseKeyToCryptoKey(coseMap);

	// 8. Compute clientDataHash
	const clientDataHash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', clientDataJSON),
	);

	// 9. Verify signature
	const signatureBytes = base64urlDecode(body.response.signature);
	const valid = await verifySignature(
		cryptoKey,
		authDataBytes,
		clientDataHash,
		signatureBytes,
		storedKeyData.algorithm,
	);

	if (!valid) {
		return c.json({ error: 'Invalid signature' }, 400);
	}

	// 10. Check sign count (must be > stored counter, unless both are 0)
	if (parsed.signCount > 0 || credRow.counter > 0) {
		if (parsed.signCount <= credRow.counter) {
			return c.json({ error: 'Sign count replay detected' }, 400);
		}
	}

	// 11. Update counter and last_used_at
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		'UPDATE webauthn_credentials SET counter = ?1, last_used_at = ?2 WHERE id = ?3',
	).bind(parsed.signCount, now, credRow.id).run();

	// 12. Check user status
	const user = await c.env.DB.prepare(
		`SELECT u.id, u.account_id, u.email, u.role, u.approved, u.disabled, u.confirmed_at,
		        a.username, a.display_name
		 FROM users u
		 JOIN accounts a ON a.id = u.account_id
		 WHERE u.id = ?1 LIMIT 1`,
	).bind(credRow.user_id).first<{
		id: string;
		account_id: string;
		email: string;
		role: string;
		approved: number;
		disabled: number;
		confirmed_at: string | null;
		username: string;
		display_name: string;
	}>();

	if (!user) {
		return c.json({ error: 'User not found' }, 400);
	}

	if (user.disabled) {
		return c.json({ error: 'Your account has been disabled' }, 403);
	}

	if (!user.approved) {
		return c.json({ error: 'Your account is pending approval' }, 403);
	}

	if (!user.confirmed_at) {
		return c.json({ error: 'Your email has not been confirmed' }, 403);
	}

	// 13. Create OAuth access token (same pattern as login.ts)
	const INTERNAL_APP_NAME = '__siliconbeest_web__';
	let appRecord = await c.env.DB.prepare(
		"SELECT id, client_id FROM oauth_applications WHERE name = ?1 LIMIT 1",
	).bind(INTERNAL_APP_NAME).first<{ id: string; client_id: string }>();

	if (!appRecord) {
		const appId = generateUlid();
		const clientId = crypto.randomUUID().replace(/-/g, '');
		const clientSecret = crypto.randomUUID().replace(/-/g, '');
		await c.env.DB.prepare(
			`INSERT INTO oauth_applications (id, name, redirect_uri, client_id, client_secret, scopes, created_at, updated_at)
			 VALUES (?1, ?2, 'urn:ietf:wg:oauth:2.0:oob', ?3, ?4, 'read write follow push', ?5, ?5)`,
		).bind(appId, INTERNAL_APP_NAME, clientId, clientSecret, now).run();
		appRecord = { id: appId, client_id: clientId };
	}

	const tokenValue = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
	const tokenHash = await sha256(tokenValue);
	const tokenId = generateUlid();

	await c.env.DB.prepare(
		`INSERT INTO oauth_access_tokens (id, token_hash, application_id, user_id, scopes, created_at)
		 VALUES (?1, ?2, ?3, ?4, 'read write follow push', ?5)`,
	).bind(tokenId, tokenHash, appRecord.id, user.id, now).run();

	// 14. Update sign-in tracking
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	await c.env.DB.prepare(
		`UPDATE users SET sign_in_count = sign_in_count + 1,
		 last_sign_in_at = current_sign_in_at, last_sign_in_ip = current_sign_in_ip,
		 current_sign_in_at = ?1, current_sign_in_ip = ?2
		 WHERE id = ?3`,
	).bind(now, ip, user.id).run();

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: 'read write follow push',
		created_at: Math.floor(new Date(now).getTime() / 1000),
	});
  } catch (err) {
    console.error('[webauthn/authenticate/verify]', err);
    return c.json({ error: 'Authentication verification failed', error_description: (err as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /credentials — List user's passkeys (authRequired)
// ---------------------------------------------------------------------------

app.get('/credentials', authRequired, async (c) => {
	const user = c.get('currentUser')!;

	const result = await c.env.DB.prepare(
		`SELECT id, credential_id, device_type, backed_up, transports, name, created_at, last_used_at
		 FROM webauthn_credentials
		 WHERE user_id = ?1
		 ORDER BY created_at DESC`,
	).bind(user.id).all<{
		id: string;
		credential_id: string;
		device_type: string | null;
		backed_up: number;
		transports: string | null;
		name: string | null;
		created_at: string;
		last_used_at: string | null;
	}>();

	return c.json(
		(result.results || []).map((row) => ({
			id: row.id,
			credential_id: row.credential_id,
			device_type: row.device_type,
			backed_up: !!row.backed_up,
			transports: row.transports ? JSON.parse(row.transports) : null,
			name: row.name,
			created_at: row.created_at,
			last_used_at: row.last_used_at,
		})),
	);
});

// ---------------------------------------------------------------------------
// DELETE /credentials/:id — Delete a passkey (authRequired)
// ---------------------------------------------------------------------------

app.delete('/credentials/:id', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const credId = c.req.param('id');

	const result = await c.env.DB.prepare(
		'DELETE FROM webauthn_credentials WHERE id = ?1 AND user_id = ?2',
	).bind(credId, user.id).run();

	if (!result.meta.changes || result.meta.changes === 0) {
		return c.json({ error: 'Credential not found' }, 404);
	}

	return c.json({});
});

// ---------------------------------------------------------------------------
// COSE key serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a COSE key Map to a JSON-storable object.
 * Stores the algorithm and the key components as base64url strings.
 */
function serializeCoseKey(coseKey: Map<number, any>, algorithm: number): string {
	const keyObj: Record<string, string> = {};

	for (const [k, v] of coseKey.entries()) {
		if (v instanceof Uint8Array) {
			keyObj[String(k)] = base64urlEncode(v);
		} else {
			keyObj[String(k)] = String(v);
		}
	}

	return JSON.stringify({ algorithm, key: keyObj });
}

/**
 * Deserialize a stored COSE key back to a Map for use with coseKeyToCryptoKey.
 */
function deserializeCoseKey(data: { algorithm: number; key: Record<string, string> }): Map<number, any> {
	const map = new Map<number, any>();

	for (const [k, v] of Object.entries(data.key)) {
		const numKey = parseInt(k, 10);

		// Keys that store byte data (negative COSE parameters = key material)
		if (numKey < 0) {
			// These are binary key components (x, y, n, e)
			map.set(numKey, base64urlDecode(v));
		} else {
			// These are integer parameters (kty, alg, crv)
			const numVal = parseInt(v, 10);
			map.set(numKey, isNaN(numVal) ? v : numVal);
		}
	}

	return map;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function arrayEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export default app;
