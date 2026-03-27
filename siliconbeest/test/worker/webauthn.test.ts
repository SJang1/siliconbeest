import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { decodeCBOR } from '../src/utils/cbor';
import { base64urlEncode, base64urlDecode } from '../src/utils/webauthn';

/**
 * WebAuthn / Passkey tests.
 *
 * Part 1: Unit tests for CBOR decoder and base64url helpers.
 * Part 2: Integration tests for WebAuthn API endpoints.
 */

// Drop all tables so applyMigration can recreate them cleanly.
// Tables in reverse dependency order (children first, parents last)
const TABLE_DELETE_ORDER = [
	'webauthn_credentials', 'status_preview_cards', 'preview_cards', 'media_proxy_cache',
	'emoji_reactions', 'filter_statuses', 'filter_keywords', 'filters', 'user_preferences',
	'markers', 'home_timeline_entries', 'conversation_accounts', 'conversations',
	'web_push_subscriptions', 'account_warnings', 'reports', 'list_accounts', 'lists',
	'tag_follows', 'status_tags', 'tags', 'mentions', 'notifications', 'bookmarks',
	'mutes', 'blocks', 'favourites', 'follow_requests', 'follows', 'poll_votes', 'polls',
	'media_attachments', 'statuses', 'oauth_authorization_codes', 'oauth_access_tokens',
	'oauth_applications', 'actor_keys', 'users', 'accounts',
	'domain_allows', 'domain_blocks', 'email_domain_blocks', 'ip_blocks',
	'instances', 'custom_emojis', 'announcements', 'rules', 'relays', 'settings',
];

async function resetDB() {
	for (const table of TABLE_DELETE_ORDER) {
		try {
			await env.DB.prepare(`DELETE FROM "${table}"`).run();
		} catch {
			// Table may not exist yet on first run
		}
	}
}

let migrated = false;

// ---------------------------------------------------------------------------
// CBOR test-data helpers
// ---------------------------------------------------------------------------

/** Encode a single CBOR unsigned integer (major type 0). */
function cborUint(value: number): Uint8Array {
	if (value < 24) return new Uint8Array([value]);
	if (value < 256) return new Uint8Array([0x18, value]);
	if (value < 65536) return new Uint8Array([0x19, (value >> 8) & 0xff, value & 0xff]);
	return new Uint8Array([
		0x1a,
		(value >> 24) & 0xff,
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff,
	]);
}

/** Encode a CBOR text string (major type 3). */
function cborText(str: string): Uint8Array {
	const encoded = new TextEncoder().encode(str);
	const header = encoded.length < 24
		? new Uint8Array([0x60 | encoded.length])
		: new Uint8Array([0x78, encoded.length]);
	const result = new Uint8Array(header.length + encoded.length);
	result.set(header, 0);
	result.set(encoded, header.length);
	return result;
}

/** Encode a CBOR byte string (major type 2). */
function cborBytes(data: Uint8Array): Uint8Array {
	const header = data.length < 24
		? new Uint8Array([0x40 | data.length])
		: new Uint8Array([0x58, data.length]);
	const result = new Uint8Array(header.length + data.length);
	result.set(header, 0);
	result.set(data, header.length);
	return result;
}

/** Encode a CBOR array header (major type 4) followed by items. */
function cborArray(items: Uint8Array[]): Uint8Array {
	const header = items.length < 24
		? new Uint8Array([0x80 | items.length])
		: new Uint8Array([0x98, items.length]);
	const total = items.reduce((s, i) => s + i.length, 0);
	const result = new Uint8Array(header.length + total);
	result.set(header, 0);
	let offset = header.length;
	for (const item of items) {
		result.set(item, offset);
		offset += item.length;
	}
	return result;
}

/** Encode a CBOR map (major type 5). */
function cborMap(entries: [Uint8Array, Uint8Array][]): Uint8Array {
	const header = entries.length < 24
		? new Uint8Array([0xa0 | entries.length])
		: new Uint8Array([0xb8, entries.length]);
	const total = entries.reduce((s, [k, v]) => s + k.length + v.length, 0);
	const result = new Uint8Array(header.length + total);
	result.set(header, 0);
	let offset = header.length;
	for (const [k, v] of entries) {
		result.set(k, offset);
		offset += k.length;
		result.set(v, offset);
		offset += v.length;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Unit tests — CBOR decoder
// ---------------------------------------------------------------------------

describe('CBOR decoder', () => {
	it('1. Decodes unsigned integer', () => {
		expect(decodeCBOR(cborUint(0))).toBe(0);
		expect(decodeCBOR(cborUint(1))).toBe(1);
		expect(decodeCBOR(cborUint(23))).toBe(23);
		expect(decodeCBOR(cborUint(24))).toBe(24);
		expect(decodeCBOR(cborUint(255))).toBe(255);
		expect(decodeCBOR(cborUint(1000))).toBe(1000);
		expect(decodeCBOR(cborUint(65535))).toBe(65535);
		expect(decodeCBOR(cborUint(100000))).toBe(100000);
	});

	it('2. Decodes text string', () => {
		expect(decodeCBOR(cborText(''))).toBe('');
		expect(decodeCBOR(cborText('hello'))).toBe('hello');
		expect(decodeCBOR(cborText('WebAuthn test'))).toBe('WebAuthn test');
	});

	it('3. Decodes byte string', () => {
		const input = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const result = decodeCBOR(cborBytes(input));
		expect(result).toBeInstanceOf(Uint8Array);
		expect(Array.from(result)).toEqual([0xde, 0xad, 0xbe, 0xef]);
	});

	it('4. Decodes array', () => {
		const encoded = cborArray([cborUint(1), cborUint(2), cborUint(3)]);
		const result = decodeCBOR(encoded);
		expect(result).toEqual([1, 2, 3]);
	});

	it('5. Decodes map', () => {
		const encoded = cborMap([
			[cborText('key'), cborText('value')],
			[cborText('num'), cborUint(42)],
		]);
		const result = decodeCBOR(encoded) as Map<string, unknown>;
		expect(result).toBeInstanceOf(Map);
		expect(result.get('key')).toBe('value');
		expect(result.get('num')).toBe(42);
	});

	it('6. Decodes boolean values', () => {
		// CBOR false = 0xf4, true = 0xf5
		expect(decodeCBOR(new Uint8Array([0xf4]))).toBe(false);
		expect(decodeCBOR(new Uint8Array([0xf5]))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Unit tests — base64url helpers
// ---------------------------------------------------------------------------

describe('base64url helpers', () => {
	it('roundtrips encode/decode', () => {
		const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
		const encoded = base64urlEncode(original);
		const decoded = base64urlDecode(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(original));
	});

	it('produces URL-safe characters (no +, /, or =)', () => {
		const data = crypto.getRandomValues(new Uint8Array(100));
		const encoded = base64urlEncode(data);
		expect(encoded).not.toContain('+');
		expect(encoded).not.toContain('/');
		expect(encoded).not.toContain('=');
	});
});

// ---------------------------------------------------------------------------
// Integration tests — WebAuthn API endpoints
// ---------------------------------------------------------------------------

describe('WebAuthn API endpoints', () => {
	beforeEach(async () => {
		if (!migrated) {
			await applyMigration();
			migrated = true;
		} else {
			await resetDB();
			// Re-insert default settings that applyMigration inserts
			await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now')), ('site_title', 'SiliconBeest', datetime('now')), ('site_description', '', datetime('now')), ('site_contact_email', '', datetime('now')), ('site_contact_username', '', datetime('now')), ('max_toot_chars', '500', datetime('now')), ('max_media_attachments', '4', datetime('now')), ('max_poll_options', '4', datetime('now')), ('poll_max_characters_per_option', '50', datetime('now')), ('media_max_image_size', '16777216', datetime('now')), ('media_max_video_size', '104857600', datetime('now')), ('thumbnail_enabled', '1', datetime('now')), ('trends_enabled', '1', datetime('now')), ('require_invite', '0', datetime('now')), ('min_password_length', '8', datetime('now'))").run();
		}
	});

	// =========================================================================
	// POST /register/options
	// =========================================================================

	it('7. POST /register/options requires auth — 401 without token', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/register/options',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(401);
	});

	it('8. POST /register/options with auth returns valid options with challenge', async () => {
		const { token } = await createTestUser('webauthn_reg');

		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/register/options',
			{
				method: 'POST',
				headers: authHeaders(token),
				body: '{}',
			},
		);
		expect(res.status).toBe(200);

		const json = (await res.json()) as {
			rp: { id: string; name: string };
			user: { id: string; name: string; displayName: string };
			challenge: string;
			pubKeyCredParams: Array<{ type: string; alg: number }>;
			timeout: number;
		};

		expect(json.rp).toBeTruthy();
		expect(json.rp.id).toBe('test.siliconbeest.local');
		expect(json.user).toBeTruthy();
		expect(json.user.name).toContain('@');
		expect(json.challenge).toBeTruthy();
		expect(json.challenge.length).toBeGreaterThan(10);
		expect(json.pubKeyCredParams).toBeInstanceOf(Array);
		expect(json.pubKeyCredParams.length).toBeGreaterThan(0);
		// Should include ES256 (-7)
		expect(json.pubKeyCredParams.some((p) => p.alg === -7)).toBe(true);
		expect(json.timeout).toBeGreaterThan(0);
	});

	// =========================================================================
	// GET /credentials
	// =========================================================================

	it('9. GET /credentials requires auth — 401 without token', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/credentials',
		);
		expect(res.status).toBe(401);
	});

	it('10. GET /credentials returns empty array for new user', async () => {
		const { token } = await createTestUser('webauthn_creds');

		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/credentials',
			{ headers: authHeaders(token) },
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as unknown[];
		expect(json).toEqual([]);
	});

	// =========================================================================
	// DELETE /credentials/:id
	// =========================================================================

	it('11. DELETE /credentials/:id requires auth — 401 without token', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/credentials/fake-id',
			{ method: 'DELETE' },
		);
		expect(res.status).toBe(401);
	});

	it('12. DELETE /credentials/:id for nonexistent returns 404', async () => {
		const { token } = await createTestUser('webauthn_delete');

		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/credentials/nonexistent-id',
			{
				method: 'DELETE',
				headers: authHeaders(token),
			},
		);
		expect(res.status).toBe(404);
	});

	// =========================================================================
	// POST /authenticate/options
	// =========================================================================

	it('13. POST /authenticate/options returns options without auth required', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/authenticate/options',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(res.status).toBe(200);

		const json = (await res.json()) as {
			challenge: string;
			rpId: string;
			timeout: number;
		};

		expect(json.challenge).toBeTruthy();
		expect(json.challenge.length).toBeGreaterThan(10);
		expect(json.rpId).toBe('test.siliconbeest.local');
		expect(json.timeout).toBeGreaterThan(0);
	});

	// =========================================================================
	// POST /authenticate/verify
	// =========================================================================

	it('14. POST /authenticate/verify with invalid data returns error', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/api/v1/auth/webauthn/authenticate/verify',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: 'fake-id',
					rawId: 'fake-raw-id',
					type: 'public-key',
					response: {
						authenticatorData: base64urlEncode(new Uint8Array(37)),
						clientDataJSON: base64urlEncode(
							new TextEncoder().encode(
								JSON.stringify({
									type: 'webauthn.get',
									challenge: 'nonexistent-challenge',
									origin: 'https://test.siliconbeest.local',
								}),
							),
						),
						signature: base64urlEncode(new Uint8Array(64)),
					},
				}),
			},
		);

		// Should fail with 400 (invalid/expired challenge) or similar error
		expect(res.status).toBeGreaterThanOrEqual(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBeTruthy();
	});
});
