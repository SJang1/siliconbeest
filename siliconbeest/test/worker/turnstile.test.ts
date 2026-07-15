import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration, createTestUser } from './helpers';
import { hashPassword } from '../../server/worker/utils/crypto';

/**
 * Turnstile CAPTCHA verification tests.
 *
 * Uses Cloudflare's official test keys:
 *   - Always-pass secret:  1x0000000000000000000000000000000AA
 *   - Always-fail secret:  2x0000000000000000000000000000000AA
 *   - Dummy client token:  1x00000000000000000000AA
 */

const TABLE_DELETE_ORDER = [
	'webauthn_credentials', 'status_preview_cards', 'preview_cards', 'media_proxy_cache',
	'emoji_reactions', 'filter_statuses', 'filter_keywords', 'filters', 'user_preferences',
	'markers', 'home_timeline_entries', 'conversation_accounts', 'conversations',
	'web_push_subscriptions', 'account_warnings', 'reports', 'list_accounts', 'lists',
	'tag_follows', 'status_tags', 'tags', 'mentions', 'notifications', 'bookmarks',
	'mutes', 'blocks', 'favourites', 'follow_requests', 'follows', 'poll_votes', 'polls',
	'media_attachments', 'statuses', 'oauth_authorization_codes', 'oauth_access_tokens',
	'oauth_applications', 'registration_invites', 'actor_keys', 'users', 'accounts',
	'domain_allows', 'domain_blocks', 'email_domain_blocks', 'ip_blocks',
	'instances', 'custom_emojis', 'announcements', 'rules', 'relays', 'settings',
];

async function resetDB() {
	for (const table of TABLE_DELETE_ORDER) {
		try {
			await env.DB.prepare(`DELETE FROM "${table}"`).run();
		} catch { /* table may not exist yet */ }
	}
}

let migrated = false;

const DEFAULT_SETTINGS_SQL = "INSERT INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now')), ('require_email_verification', '1', datetime('now')), ('site_title', 'SiliconBeest', datetime('now')), ('site_description', '', datetime('now')), ('site_contact_email', '', datetime('now')), ('site_contact_username', '', datetime('now')), ('max_toot_chars', '500', datetime('now')), ('max_media_attachments', '4', datetime('now')), ('max_poll_options', '4', datetime('now')), ('poll_max_characters_per_option', '50', datetime('now')), ('media_max_image_size', '16777216', datetime('now')), ('media_max_video_size', '104857600', datetime('now')), ('thumbnail_enabled', '1', datetime('now')), ('trends_enabled', '1', datetime('now')), ('require_invite', '0', datetime('now')), ('min_password_length', '8', datetime('now'))";

const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const SITE_KEY = '1x00000000000000000000AA';
const DUMMY_TOKEN = '1x00000000000000000000AA';
let registrationRequestIp = 1;
let loginRequestIp = 1;

interface LoginClientContext {
	ip: string;
	userAgent: string;
}

function createLoginClientContext(): LoginClientContext {
	return {
		ip: `198.51.100.${loginRequestIp++}`,
		userAgent: 'SiliconBeest login preflight test',
	};
}

function loginClientHeaders(context: LoginClientContext): Record<string, string> {
	return {
		'CF-Connecting-IP': context.ip,
		'User-Agent': context.userAgent,
	};
}

async function enableTurnstile(secretKey: string = PASS_SECRET) {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_enabled', '1', datetime('now'))",
		),
		env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_site_key', ?1, datetime('now'))",
		).bind(SITE_KEY),
		env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_secret_key', ?1, datetime('now'))",
		).bind(secretKey),
	]);
	// Clear KV cache so the new settings are picked up
	await env.CACHE.delete('settings:turnstile');
}

async function disableTurnstile() {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_enabled', '0', datetime('now'))",
		),
		env.DB.prepare("DELETE FROM settings WHERE key = 'turnstile_site_key'"),
		env.DB.prepare("DELETE FROM settings WHERE key = 'turnstile_secret_key'"),
	]);
	await env.CACHE.delete('settings:turnstile');
}

async function registerRequest(body: Record<string, unknown>) {
	return SELF.fetch('https://test.siliconbeest.local/api/v1/accounts', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'CF-Connecting-IP': `203.0.113.${registrationRequestIp++}`,
		},
		body: JSON.stringify({
			username: 'turnstile_user_' + Math.random().toString(36).slice(2, 8),
			email: `turnstile_${Math.random().toString(36).slice(2, 8)}@test.local`,
			password: 'securepassword123',
			agreement: true,
			...body,
		}),
	});
}

async function loginRequest(
	body: Record<string, unknown>,
	context: LoginClientContext = createLoginClientContext(),
	cookie?: string,
) {
	return SELF.fetch('https://test.siliconbeest.local/api/v1/auth/login', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...loginClientHeaders(context),
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function loginPreflightStatus(context: LoginClientContext, cookie?: string) {
	return SELF.fetch('https://test.siliconbeest.local/api/v1/auth/login/preflight', {
		headers: {
			...loginClientHeaders(context),
			...(cookie ? { Cookie: cookie } : {}),
		},
	});
}

async function submitLoginPreflight(
	context: LoginClientContext,
	returnTo: string = '/login',
	token: string = DUMMY_TOKEN,
) {
	return SELF.fetch('https://test.siliconbeest.local/api/v1/auth/login/preflight', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...loginClientHeaders(context),
		},
		body: new URLSearchParams({
			turnstile_token: token,
			return_to: returnTo,
		}).toString(),
		redirect: 'manual',
	});
}

function extractCookie(response: Response): string {
	const setCookie = response.headers.get('set-cookie');
	expect(setCookie).toBeTruthy();
	return setCookie!.split(';', 1)[0];
}

describe('Turnstile CAPTCHA verification', () => {
	beforeEach(async () => {
		if (!migrated) {
			await applyMigration();
			migrated = true;
		} else {
			await resetDB();
			await env.DB.prepare(DEFAULT_SETTINGS_SQL).run();
		}
		await env.CACHE.delete('settings:turnstile');
	});

	// =========================================================================
	// Turnstile ENABLED
	// =========================================================================

	describe('Turnstile enabled', () => {
		it('1. Registration without turnstile_token returns 422', async () => {
			await enableTurnstile();
			const res = await registerRequest({});
			expect(res.status).toBe(422);
			const json = (await res.json()) as { error: string; error_description?: string };
			expect(json.error_description || json.error).toContain('CAPTCHA');
		});

		it('2. Registration with empty turnstile_token returns 422', async () => {
			await enableTurnstile();
			const res = await registerRequest({ turnstile_token: '' });
			expect(res.status).toBe(422);
			const json = (await res.json()) as { error: string; error_description?: string };
			expect(json.error_description || json.error).toContain('CAPTCHA');
		});

		it('3. Registration with invalid turnstile_token (failing secret) returns 422', async () => {
			await enableTurnstile(FAIL_SECRET);
			const res = await registerRequest({ turnstile_token: DUMMY_TOKEN });
			expect(res.status).toBe(422);
			const json = (await res.json()) as { error: string; error_description?: string };
			expect(json.error_description || json.error).toContain('CAPTCHA');
		});

		it('4. Registration with valid turnstile_token (passing secret) succeeds', async () => {
			await enableTurnstile(PASS_SECRET);
			const res = await registerRequest({ turnstile_token: DUMMY_TOKEN });
			expect(res.status).toBe(200);
			const json = (await res.json()) as { registration_required?: boolean };
			expect(json.registration_required).toBe(true);
		});

		it('5. Login preflight status requires a challenge before verification', async () => {
			await enableTurnstile();
			const context = createLoginClientContext();
			const res = await loginPreflightStatus(context);

			expect(res.status).toBe(200);
			expect(res.headers.get('cache-control')).toContain('no-store');
			const json = (await res.json()) as {
				required: boolean;
				passed: boolean;
				site_key: string;
			};
			expect(json).toEqual({
				required: true,
				passed: false,
				site_key: SITE_KEY,
			});
		});

		it('6. Invalid login preflight challenge returns to the gate without a session cookie', async () => {
			await enableTurnstile(FAIL_SECRET);
			const context = createLoginClientContext();
			const res = await submitLoginPreflight(context);

			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe('/login?turnstile_error=failed');
			expect(res.headers.get('set-cookie')).toBeNull();
		});

		it('7. Login is rejected without a valid preflight session', async () => {
			await enableTurnstile();
			const context = createLoginClientContext();
			const res = await loginRequest(
				{ email: 'test@test.local', password: 'pass' },
				context,
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'login_preflight_required' });
		});

		it('8. A legacy body turnstile_token cannot bypass the preflight session', async () => {
			await enableTurnstile(PASS_SECRET);
			const context = createLoginClientContext();
			const res = await loginRequest(
				{
					email: 'test@test.local',
					password: 'pass',
					turnstile_token: DUMMY_TOKEN,
				},
				context,
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'login_preflight_required' });
		});

		it('9. Valid preflight cookie allows password login without a body token', async () => {
			await enableTurnstile(PASS_SECRET);
			const context = createLoginClientContext();
			const preflight = await submitLoginPreflight(context);
			expect(preflight.status).toBe(303);
			expect(preflight.headers.get('location')).toBe('/login');
			const cookie = extractCookie(preflight);

			const status = await loginPreflightStatus(context, cookie);
			expect(status.status).toBe(200);
			expect(await status.json()).toEqual({
				required: true,
				passed: true,
				site_key: SITE_KEY,
			});

			const { userId } = await createTestUser('turnstile_login');
			const hashed = await hashPassword('testpassword123');
			await env.DB.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2').bind(
				hashed,
				userId,
			).run();

			const res = await loginRequest(
				{
					email: 'turnstile_login@test.local',
					password: 'testpassword123',
				},
				context,
				cookie,
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { access_token: string };
			expect(json.access_token).toBeTruthy();
		});

		it('10. Login preflight preserves a nested redirect query', async () => {
			await enableTurnstile(PASS_SECRET);
			const context = createLoginClientContext();
			const returnTo = '/aurora/login?redirect=%2Foauth%2Fauthorize%3Fclient_id%3Dclient-123%26redirect_uri%3Dhttps%253A%252F%252Fclient.example%252Fcallback';
			const res = await submitLoginPreflight(context, returnTo);

			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe(returnTo);
			expect(res.headers.get('set-cookie')).toContain('siliconbeest_login_preflight=');
		});

		it('11. Login preflight rejects an external return target with a safe fallback', async () => {
			await enableTurnstile(PASS_SECRET);
			const context = createLoginClientContext();
			const res = await submitLoginPreflight(
				context,
				'https://attacker.example/steal-login-session',
			);

			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe('/login');
			expect(res.headers.get('set-cookie')).toContain('siliconbeest_login_preflight=');
		});
	});

	// =========================================================================
	// Turnstile DISABLED
	// =========================================================================

	describe('Turnstile disabled', () => {
		it('9. Registration without turnstile_token succeeds when disabled', async () => {
			await disableTurnstile();
			const res = await registerRequest({});
			expect(res.status).toBe(200);
			const json = (await res.json()) as { registration_required?: boolean };
			expect(json.registration_required).toBe(true);
		});

		it('10. Login without turnstile_token succeeds when disabled', async () => {
			await disableTurnstile();
			const { userId } = await createTestUser('no_turnstile_login');
			const hashed = await hashPassword('testpassword123');
			await env.DB.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2').bind(
				hashed,
				userId,
			).run();

			const res = await loginRequest({
				email: 'no_turnstile_login@test.local',
				password: 'testpassword123',
			});
			expect(res.status).toBe(200);
			const json = (await res.json()) as { access_token: string };
			expect(json.access_token).toBeTruthy();
		});
	});

	// =========================================================================
	// Edge cases
	// =========================================================================

	describe('Edge cases', () => {
		it('11. turnstile_enabled=1 but no secret_key skips verification', async () => {
			// Enable turnstile but without secret key
			await env.DB.prepare(
				"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_enabled', '1', datetime('now'))",
			).run();
			await env.DB.prepare("DELETE FROM settings WHERE key = 'turnstile_secret_key'").run();
			await env.DB.prepare("DELETE FROM settings WHERE key = 'turnstile_site_key'").run();
			await env.CACHE.delete('settings:turnstile');

			// Registration should succeed without token since secretKey is empty
			const res = await registerRequest({});
			expect(res.status).toBe(200);
		});

		it('12. turnstile_enabled=0 with valid keys skips verification', async () => {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_enabled', '0', datetime('now'))",
				),
				env.DB.prepare(
					"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_site_key', ?1, datetime('now'))",
				).bind(SITE_KEY),
				env.DB.prepare(
					"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('turnstile_secret_key', ?1, datetime('now'))",
				).bind(PASS_SECRET),
			]);
			await env.CACHE.delete('settings:turnstile');

			// Registration should succeed without token since turnstile is disabled
			const res = await registerRequest({});
			expect(res.status).toBe(200);
		});

		it('13. Instance API /api/v2/instance includes turnstile config when enabled', async () => {
			await enableTurnstile();
			const res = await SELF.fetch('https://test.siliconbeest.local/api/v2/instance');
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				configuration: {
					turnstile: { enabled: boolean; site_key: string };
				};
			};
			expect(json.configuration.turnstile.enabled).toBe(true);
			expect(json.configuration.turnstile.site_key).toBe(SITE_KEY);
		});

		it('14. Instance API shows turnstile disabled when not configured', async () => {
			await disableTurnstile();
			const res = await SELF.fetch('https://test.siliconbeest.local/api/v2/instance');
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				configuration: {
					turnstile: { enabled: boolean; site_key: string };
				};
			};
			expect(json.configuration.turnstile.enabled).toBe(false);
		});
	});
});
