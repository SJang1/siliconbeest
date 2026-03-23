/**
 * Instance Actor Endpoint
 *
 * GET /actor — returns the instance-level Application actor for relay subscriptions.
 * This actor's keypair is stored in actor_keys with account_id = '__instance__'.
 * If no keypair exists yet, generate one on first request (lazy init).
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { generateUlid } from '../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * Convert an ArrayBuffer to a base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * Wrap base64-encoded key material in PEM format.
 */
function toPem(base64: string, type: 'PUBLIC' | 'PRIVATE'): string {
	const label = type === 'PUBLIC' ? 'PUBLIC KEY' : 'PRIVATE KEY';
	const lines: string[] = [];
	for (let i = 0; i < base64.length; i += 64) {
		lines.push(base64.substring(i, i + 64));
	}
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

app.get('/', async (c) => {
	const domain = c.env.INSTANCE_DOMAIN;

	// Check if instance actor key exists
	let actorKey = await c.env.DB.prepare(
		"SELECT * FROM actor_keys WHERE account_id = '__instance__'",
	).first<{ id: string; public_key: string; private_key: string; key_id: string }>();

	// Lazy-init: generate keypair if not exists
	if (!actorKey) {
		const keyPair = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256',
			},
			true,
			['sign', 'verify'],
		) as CryptoKeyPair;

		const pubKeyData = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
		const privKeyData = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;

		const publicKeyPem = toPem(arrayBufferToBase64(pubKeyData), 'PUBLIC');
		const privateKeyPem = toPem(arrayBufferToBase64(privKeyData), 'PRIVATE');

		const keyId = `https://${domain}/actor#main-key`;
		const id = generateUlid();
		const now = new Date().toISOString();

		// Ensure __instance__ account exists (FK requirement)
		await c.env.DB.prepare(
			`INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
			 VALUES ('__instance__', ?1, NULL, ?2, '', ?3, ?4, ?5, ?5)`,
		)
			.bind(domain, c.env.INSTANCE_TITLE || 'SiliconBeest', `https://${domain}/actor`, `https://${domain}/about`, now)
			.run();

		await c.env.DB.prepare(
			`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
			 VALUES (?1, '__instance__', ?2, ?3, ?4, ?5)`,
		)
			.bind(id, publicKeyPem, privateKeyPem, keyId, now)
			.run();

		actorKey = {
			id,
			public_key: publicKeyPem,
			private_key: privateKeyPem,
			key_id: keyId,
		};
	}

	return c.json(
		{
			'@context': [
				'https://www.w3.org/ns/activitystreams',
				'https://w3id.org/security/v1',
			],
			id: `https://${domain}/actor`,
			type: 'Application',
			preferredUsername: domain,
			name: c.env.INSTANCE_TITLE || 'SiliconBeest',
			inbox: `https://${domain}/inbox`,
			outbox: `https://${domain}/outbox`,
			url: `https://${domain}/about`,
			publicKey: {
				id: `https://${domain}/actor#main-key`,
				owner: `https://${domain}/actor`,
				publicKeyPem: actorKey.public_key,
			},
			endpoints: { sharedInbox: `https://${domain}/inbox` },
		},
		200,
		{ 'Content-Type': 'application/activity+json' },
	);
});

export default app;
