import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

async function generateRSAKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: { name: 'SHA-256' } },
		true, ['sign', 'verify'],
	);
	const pub = await crypto.subtle.exportKey('spki', keyPair.publicKey);
	const priv = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
	const toB64 = (buf: ArrayBuffer) => {
		const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
		return b.match(/.{1,64}/g)!.join('\n');
	};
	return {
		publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${toB64(pub)}\n-----END PUBLIC KEY-----`,
		privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${toB64(priv)}\n-----END PRIVATE KEY-----`,
	};
}

describe('Activity Idempotency (DB-based)', () => {
	let user: { accountId: string; userId: string; token: string };
	let privateKeyPem: string;

	beforeAll(async () => {
		await applyMigration();
		user = await createTestUser('idempuser');
		const keys = await generateRSAKeyPair();
		privateKeyPem = keys.privateKeyPem;
		const now = new Date().toISOString();
		const remoteAccountId = crypto.randomUUID();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, inbox_url, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
			).bind(remoteAccountId, 'remoteactor', 'remote.example.com', 'Remote Actor',
				'https://remote.example.com/users/remoteactor', 'https://remote.example.com/@remoteactor',
				'https://remote.example.com/users/remoteactor/inbox', now, now),
			env.DB.prepare(
				`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(crypto.randomUUID(), remoteAccountId, keys.publicKeyPem, 'unused',
				'https://remote.example.com/users/remoteactor#main-key', now),
		]);
	});

	it('duplicate activities are handled gracefully by DB UNIQUE constraints', async () => {
		const { signRequest } = await import('../src/federation/httpSignatures');
		const activity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example.com/activities/dup-test-1',
			type: 'Like',
			actor: 'https://remote.example.com/users/remoteactor',
			object: `https://${DOMAIN}/users/idempuser/statuses/nonexistent`,
		};
		const body = JSON.stringify(activity);
		const url = `${BASE}/users/idempuser/inbox`;
		const headers = await signRequest(privateKeyPem, 'https://remote.example.com/users/remoteactor#main-key', url, 'POST', body);

		// Send same activity twice
		const res1 = await SELF.fetch(url, { method: 'POST', headers, body });
		expect(res1.status).toBe(202);

		const res2 = await SELF.fetch(url, { method: 'POST', headers, body });
		expect(res2.status).toBe(202); // Should not crash
	});

	it('different activities are both accepted', async () => {
		const { signRequest } = await import('../src/federation/httpSignatures');
		const url = `${BASE}/users/idempuser/inbox`;

		for (const id of ['distinct-a', 'distinct-b']) {
			const activity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `https://remote.example.com/activities/${id}`,
				type: 'Like',
				actor: 'https://remote.example.com/users/remoteactor',
				object: `https://${DOMAIN}/users/idempuser/statuses/1`,
			};
			const body = JSON.stringify(activity);
			const headers = await signRequest(privateKeyPem, 'https://remote.example.com/users/remoteactor#main-key', url, 'POST', body);
			const res = await SELF.fetch(url, { method: 'POST', headers, body });
			expect(res.status).toBe(202);
		}
	});
});
