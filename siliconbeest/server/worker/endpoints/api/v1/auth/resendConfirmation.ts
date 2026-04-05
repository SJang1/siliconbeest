import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { generateToken } from '../../../../utils/crypto';
import { sendConfirmation } from '../../../../services/email';
import { getUserForConfirmation, setConfirmationToken } from '../../../../services/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/auth/resend_confirmation
 *
 * Resend the email confirmation link. Rate-limited to once per 60 seconds per email.
 * Always returns 200 to prevent email enumeration.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ email?: string }>().catch((): { email?: string } => ({}));
	const email = body.email?.toLowerCase().trim();

	if (!email) {
		return c.json({ message: 'If your email is in our system, a confirmation link has been sent.' }, 200);
	}

	// Rate limit: 60-second cooldown per email
	const cooldownKey = 'resend_cooldown:' + email;
	const cooldown = await c.env.CACHE.get(cooldownKey);
	if (cooldown) {
		return c.json({ error: 'Please wait before requesting another confirmation email' }, 429);
	}

	// Look up user by email
	const user = await getUserForConfirmation(c.env.DB, email);

	// If not found or already confirmed, return 200 silently
	if (!user || user.confirmed_at) {
		return c.json({ message: 'If your email is in our system, a confirmation link has been sent.' }, 200);
	}

	// Delete old KV entry if there was a previous token
	if (user.confirmation_token) {
		await c.env.CACHE.delete('email_confirm:' + user.confirmation_token);
	}

	// Generate new token
	const newToken = generateToken(64);
	await c.env.CACHE.put(
		'email_confirm:' + newToken,
		JSON.stringify({ userId: user.id, email }),
		{ expirationTtl: 86400 },
	);
	await setConfirmationToken(c.env.DB, user.id, newToken);

	// Set cooldown
	await c.env.CACHE.put(cooldownKey, '1', { expirationTtl: 60 });

	// Send confirmation email
	try {
		await sendConfirmation(c.env, email, newToken);
	} catch { /* best-effort */ }

	return c.json({ message: 'If your email is in our system, a confirmation link has been sent.' }, 200);
});

export default app;
