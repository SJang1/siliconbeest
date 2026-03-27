import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

/**
 * Email verification flow tests.
 *
 * Covers registration → confirmation → login lifecycle,
 * resend_confirmation endpoint, and admin approval interactions.
 */

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
		} catch { /* table may not exist yet */ }
	}
}

let migrated = false;

const DEFAULT_SETTINGS_SQL = "INSERT INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now')), ('site_title', 'SiliconBeest', datetime('now')), ('site_description', '', datetime('now')), ('site_contact_email', '', datetime('now')), ('site_contact_username', '', datetime('now')), ('max_toot_chars', '500', datetime('now')), ('max_media_attachments', '4', datetime('now')), ('max_poll_options', '4', datetime('now')), ('poll_max_characters_per_option', '50', datetime('now')), ('media_max_image_size', '16777216', datetime('now')), ('media_max_video_size', '104857600', datetime('now')), ('thumbnail_enabled', '1', datetime('now')), ('trends_enabled', '1', datetime('now')), ('require_invite', '0', datetime('now')), ('min_password_length', '8', datetime('now'))";

async function registerUser(username: string, email?: string) {
	const e = email || `${username}@test.local`;
	const res = await SELF.fetch('https://test.siliconbeest.local/api/v1/accounts', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username,
			email: e,
			password: 'securepassword123',
			agreement: true,
		}),
	});
	return { res, email: e };
}

async function loginRequest(email: string, password: string) {
	return SELF.fetch('https://test.siliconbeest.local/api/v1/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
}

async function resendConfirmation(email: string) {
	return SELF.fetch(
		'https://test.siliconbeest.local/api/v1/auth/resend_confirmation',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email }),
		},
	);
}

describe('Email verification', () => {
	beforeEach(async () => {
		if (!migrated) {
			await applyMigration();
			migrated = true;
		} else {
			await resetDB();
			await env.DB.prepare(DEFAULT_SETTINGS_SQL).run();
		}
	});

	// =========================================================================
	// Registration behaviour
	// =========================================================================

	it('1. Registration sets confirmed_at = NULL', async () => {
		const { res, email } = await registerUser('verify_reg');
		expect(res.status).toBe(200);

		const user = await env.DB.prepare(
			'SELECT confirmed_at FROM users WHERE email = ?1',
		)
			.bind(email)
			.first<{ confirmed_at: string | null }>();
		expect(user).toBeTruthy();
		expect(user!.confirmed_at).toBeNull();
	});

	it('2. Registration returns { confirmation_required: true }', async () => {
		const { res } = await registerUser('verify_reg2');
		expect(res.status).toBe(200);
		const json = (await res.json()) as { confirmation_required: boolean };
		expect(json.confirmation_required).toBe(true);
	});

	// =========================================================================
	// Login with unconfirmed email
	// =========================================================================

	it('3. Login with unconfirmed email returns 403', async () => {
		// Register (confirmed_at stays NULL)
		await registerUser('unconfirmed_user');

		// Attempt login
		const res = await loginRequest('unconfirmed_user@test.local', 'securepassword123');
		expect(res.status).toBe(403);
		const json = (await res.json()) as { error: string };
		expect(json.error.toLowerCase()).toContain('confirm');
	});

	// =========================================================================
	// Confirmation endpoint — GET /auth/confirm
	// =========================================================================

	it('4. GET /auth/confirm with valid token confirms user and returns success HTML', async () => {
		// Register to get a confirmation token
		const { email } = await registerUser('confirm_valid');
		const user = await env.DB.prepare(
			'SELECT id, confirmation_token FROM users WHERE email = ?1',
		)
			.bind(email)
			.first<{ id: string; confirmation_token: string }>();
		expect(user).toBeTruthy();
		expect(user!.confirmation_token).toBeTruthy();

		const token = user!.confirmation_token;

		const res = await SELF.fetch(
			`https://test.siliconbeest.local/auth/confirm?token=${token}`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html.toLowerCase()).toContain('confirmed');

		// DB should now have confirmed_at set
		const updated = await env.DB.prepare(
			'SELECT confirmed_at FROM users WHERE id = ?1',
		)
			.bind(user!.id)
			.first<{ confirmed_at: string | null }>();
		expect(updated!.confirmed_at).toBeTruthy();
	});

	it('5. GET /auth/confirm with invalid/expired token returns error HTML', async () => {
		const res = await SELF.fetch(
			'https://test.siliconbeest.local/auth/confirm?token=invalid_token_12345',
		);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html.toLowerCase()).toContain('expired');
	});

	it('6. GET /auth/confirm with already-used token returns error (KV entry deleted)', async () => {
		// Register user
		const { email } = await registerUser('confirm_reuse');
		const user = await env.DB.prepare(
			'SELECT confirmation_token FROM users WHERE email = ?1',
		)
			.bind(email)
			.first<{ confirmation_token: string }>();
		const token = user!.confirmation_token;

		// First confirmation — should succeed
		const res1 = await SELF.fetch(
			`https://test.siliconbeest.local/auth/confirm?token=${token}`,
		);
		expect(res1.status).toBe(200);

		// Second attempt — KV entry deleted, should fail
		const res2 = await SELF.fetch(
			`https://test.siliconbeest.local/auth/confirm?token=${token}`,
		);
		expect(res2.status).toBe(400);
	});

	// =========================================================================
	// Resend confirmation
	// =========================================================================

	it('7. POST /api/v1/auth/resend_confirmation returns 200', async () => {
		await registerUser('resend_user');

		const res = await resendConfirmation('resend_user@test.local');
		expect(res.status).toBe(200);
	});

	it('8. POST /api/v1/auth/resend_confirmation rate limit returns 429 on second call within 60s', async () => {
		await registerUser('ratelimit_user');

		const res1 = await resendConfirmation('ratelimit_user@test.local');
		expect(res1.status).toBe(200);

		// Second call within 60s should be rate limited
		const res2 = await resendConfirmation('ratelimit_user@test.local');
		expect(res2.status).toBe(429);
	});

	it('9. POST /api/v1/auth/resend_confirmation for confirmed user returns 200 (silent)', async () => {
		// createTestUser sets confirmed_at to NOW, so the user is already confirmed
		await createTestUser('already_confirmed');

		const res = await resendConfirmation('already_confirmed@test.local');
		expect(res.status).toBe(200);
		const json = (await res.json()) as { message: string };
		expect(json.message).toBeTruthy();
	});

	it('10. POST /api/v1/auth/resend_confirmation for nonexistent email returns 200 (silent)', async () => {
		const res = await resendConfirmation('nonexistent@test.local');
		expect(res.status).toBe(200);
	});

	// =========================================================================
	// Login after confirmation
	// =========================================================================

	it('11. Login after confirmation succeeds', async () => {
		// Register user
		const { email } = await registerUser('confirm_then_login');

		// Get the confirmation token
		const user = await env.DB.prepare(
			'SELECT confirmation_token FROM users WHERE email = ?1',
		)
			.bind(email)
			.first<{ confirmation_token: string }>();
		const token = user!.confirmation_token;

		// Confirm
		const confirmRes = await SELF.fetch(
			`https://test.siliconbeest.local/auth/confirm?token=${token}`,
		);
		expect(confirmRes.status).toBe(200);

		// Now login should work
		const loginRes = await loginRequest(email, 'securepassword123');
		expect(loginRes.status).toBe(200);
		const json = (await loginRes.json()) as { access_token: string };
		expect(json.access_token).toBeTruthy();
	});

	// =========================================================================
	// Admin approval interactions
	// =========================================================================

	it('12. Admin cannot approve unconfirmed user — returns 422', async () => {
		// Set approval mode
		await env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', 'approval', datetime('now'))",
		).run();

		// Register user (unconfirmed, unapproved)
		await registerUser('unapproved_user');

		// Get account id
		const account = await env.DB.prepare(
			"SELECT id FROM accounts WHERE username = 'unapproved_user' AND domain IS NULL",
		).first<{ id: string }>();
		expect(account).toBeTruthy();

		// Create admin user
		const admin = await createTestUser('admin_approver', { role: 'admin' });

		// Try to approve — should fail because user is not confirmed
		const res = await SELF.fetch(
			`https://test.siliconbeest.local/api/v1/admin/accounts/${account!.id}/approve`,
			{
				method: 'POST',
				headers: authHeaders(admin.token),
			},
		);
		expect(res.status).toBe(422);
	});

	// =========================================================================
	// Open mode still requires email verification
	// =========================================================================

	it('13. In open mode: confirmed_at is still NULL on registration', async () => {
		// Ensure open registration mode (already default from migration)
		await env.DB.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now'))",
		).run();

		const { email } = await registerUser('open_mode_user');

		const user = await env.DB.prepare(
			'SELECT confirmed_at FROM users WHERE email = ?1',
		)
			.bind(email)
			.first<{ confirmed_at: string | null }>();
		expect(user).toBeTruthy();
		expect(user!.confirmed_at).toBeNull();
	});
});
