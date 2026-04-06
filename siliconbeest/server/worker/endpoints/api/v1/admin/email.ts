import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { sendCustomEmail } from '../../../../services/email';
import { getInstanceTitle } from '../../../../services/instance';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * POST /api/v1/admin/email — send an email to a specific address.
 * Body: { to: string, subject: string, body: string }
 */
app.post('/', async (c) => {
	const payload = await c.req.json<{ to?: string; subject?: string; body?: string }>().catch((): { to?: string; subject?: string; body?: string } => ({}));

	if (!payload.to || !payload.subject || !payload.body) {
		throw new AppError(422, 'Validation failed: to, subject, and body are required');
	}

	const sent = await sendCustomEmail(payload.to, payload.subject, payload.body);

	return c.json({ sent }, 200);
});

/**
 * POST /api/v1/admin/email/test — send a test email to the current admin.
 */
app.post('/test', async (c) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) throw new AppError(401, 'The access token is invalid');

	const title = await getInstanceTitle();
	const html = `<h1>Test Email</h1><p>This is a test email from <strong>${title}</strong>. If you received this, SMTP is configured correctly.</p>`;

	const sent = await sendCustomEmail(currentUser.email, `[${title}] Test email`, html);

	if (!sent) {
		throw new AppError(422, 'Email not sent', 'SMTP is not configured or delivery failed');
	}
	return c.json({ sent: true }, 200);
});

export default app;
