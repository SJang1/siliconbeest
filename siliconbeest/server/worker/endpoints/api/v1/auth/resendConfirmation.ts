import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { getUserForConfirmation } from '../../../../services/auth';
import { startEmailVerification } from '../../../../services/registration';

type HonoEnv = { Variables: AppVariables };

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
	const cooldown = await env.CACHE.get(cooldownKey);
	if (cooldown) {
		return c.json({ error: 'Please wait before requesting another confirmation email' }, 429);
	}

	// Look up user by email
	const user = await getUserForConfirmation(email);

	// If not found, already confirmed, or still awaiting administrator approval,
	// return 200 silently. Approval sends its own continuation email.
	if (!user
		|| user.confirmed_at
		|| user.registration_state === 'pending_approval'
		|| user.registration_state === 'active') {
		return c.json({ message: 'If your email is in our system, a confirmation link has been sent.' }, 200);
	}

	// Set cooldown
	await env.CACHE.put(cooldownKey, '1', { expirationTtl: 60 });

	// Use the same 60-minute code/link lifecycle as the registration UI.
	// The service invalidates the previous challenge before issuing a new one.
	await startEmailVerification(user.id).catch(() => undefined);

	return c.json({ message: 'If your email is in our system, a confirmation link has been sent.' }, 200);
});

export default app;
