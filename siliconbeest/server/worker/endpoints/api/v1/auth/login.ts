/**
 * Direct login endpoint for the built-in frontend.
 * POST /api/v1/auth/login
 *
 * This is a non-standard convenience endpoint that combines
 * OAuth app creation + authorization + token exchange into one step.
 * Third-party apps should use the standard OAuth 2.0 flow instead.
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { generateUlid } from '../../../../utils/ulid';
import { sha256 } from '../../../../utils/crypto';
import { verifyTurnstile, getTurnstileSettings } from '../../../../utils/turnstile';
import bcrypt from 'bcryptjs';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ email?: string; password?: string; turnstile_token?: string }>().catch(() => ({} as any));
	const { email, password } = body;

	if (!email || !password) {
		return c.json({ error: 'Email and password are required' }, 422);
	}

	// Turnstile CAPTCHA verification (if enabled)
	const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);
	if (turnstile.enabled && turnstile.secretKey) {
		if (!body.turnstile_token) {
			return c.json({ error: 'CAPTCHA verification failed. Please try again.' }, 422);
		}
		const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
		const valid = await verifyTurnstile(body.turnstile_token, turnstile.secretKey, ip);
		if (!valid) {
			return c.json({ error: 'CAPTCHA verification failed. Please try again.' }, 422);
		}
	}

	// Find user by email
	const user = await c.env.DB.prepare(
		`SELECT u.id, u.account_id, u.encrypted_password, u.role, u.approved, u.disabled, u.otp_enabled, u.confirmed_at,
		        a.username, a.display_name
		 FROM users u
		 JOIN accounts a ON a.id = u.account_id
		 WHERE u.email = ?1 LIMIT 1`,
	)
		.bind(email.toLowerCase().trim())
		.first<{
			id: string;
			account_id: string;
			encrypted_password: string;
			role: string;
			approved: number;
			disabled: number;
			otp_enabled: number;
			confirmed_at: string | null;
			username: string;
			display_name: string;
		}>();

	if (!user) {
		return c.json({ error: 'Invalid email or password' }, 401);
	}

	if (user.disabled) {
		return c.json({ error: 'Your account has been disabled' }, 403);
	}

	if (!user.approved) {
		return c.json({ error: 'Your account is pending approval' }, 403);
	}

	// Verify password (support both bcrypt and pbkdf2 formats)
	let passwordValid = false;
	const hash = user.encrypted_password;

	if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
		// bcrypt
		passwordValid = await bcrypt.compare(password, hash);
	} else if (hash.startsWith('pbkdf2:')) {
		// pbkdf2:saltHex:hashHex format
		const parts = hash.split(':');
		if (parts.length === 3) {
			const saltHex = parts[1]!;
			const storedHash = parts[2]!;
			// Convert hex salt back to bytes
			const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));
			const encoder = new TextEncoder();
			const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
			const derived = await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
				keyMaterial,
				256,
			);
			const derivedHex = Array.from(new Uint8Array(derived)).map((b) => b.toString(16).padStart(2, '0')).join('');
			passwordValid = derivedHex === storedHash;
		}
	} else {
		// Plain comparison for test/dummy hashes
		passwordValid = hash === password;
	}

	if (!passwordValid) {
		return c.json({ error: 'Invalid email or password' }, 401);
	}

	if (!user.confirmed_at) {
		return c.json({ error: 'Email not confirmed', error_description: 'Please confirm your email address' }, 403);
	}

	// TODO: Handle 2FA (otp_enabled) — for now, skip

	// Create or find internal app for the built-in frontend
	const INTERNAL_APP_NAME = '__siliconbeest_web__';
	let app_record = await c.env.DB.prepare(
		"SELECT id, client_id FROM oauth_applications WHERE name = ?1 LIMIT 1",
	).bind(INTERNAL_APP_NAME).first<{ id: string; client_id: string }>();

	if (!app_record) {
		const appId = generateUlid();
		const clientId = crypto.randomUUID().replace(/-/g, '');
		const clientSecret = crypto.randomUUID().replace(/-/g, '');
		const now = new Date().toISOString();
		await c.env.DB.prepare(
			`INSERT INTO oauth_applications (id, name, redirect_uri, client_id, client_secret, scopes, created_at, updated_at)
			 VALUES (?1, ?2, 'urn:ietf:wg:oauth:2.0:oob', ?3, ?4, 'read write follow push', ?5, ?5)`,
		).bind(appId, INTERNAL_APP_NAME, clientId, clientSecret, now).run();
		app_record = { id: appId, client_id: clientId };
	}

	// Generate access token — store SHA-256 hash, not plaintext
	const tokenValue = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
	const tokenHash = await sha256(tokenValue);
	const tokenId = generateUlid();
	const now = new Date().toISOString();

	await c.env.DB.prepare(
		`INSERT INTO oauth_access_tokens (id, token_hash, application_id, user_id, scopes, created_at)
		 VALUES (?1, ?2, ?3, ?4, 'read write follow push', ?5)`,
	).bind(tokenId, tokenHash, app_record.id, user.id, now).run();

	// Update sign-in tracking
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
});

export default app;
