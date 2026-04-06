/**
 * Find username by email endpoint.
 * POST /api/v1/auth/find_username
 *
 * Sends an email containing the user's handle if an account exists.
 * Always returns 200 to prevent email enumeration.
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { findUsernameByEmail } from '../../../../services/auth';
import { sendUsernameReminder } from '../../../../services/email';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ email?: string }>()
		.catch((): { email?: string } => ({}));
	const { email } = body;

	if (!email) {
		return c.json({ error: 'Email is required' }, 422);
	}

	const result = await findUsernameByEmail(email);

	if (result) {
		try {
			await sendUsernameReminder(email, result.username, result.locale || 'en');
		} catch { /* best-effort */ }
	}

	// Always return 200 to prevent email enumeration
	return c.json({ message: 'If an account with that email exists, a reminder has been sent.' });
});

export default app;
