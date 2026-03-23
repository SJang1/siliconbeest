import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminRequired } from '../../../../middleware/auth';
import { sendEmail } from '../../../../services/email';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * POST /api/v1/admin/email — send an email to a specific address.
 * Body: { to: string, subject: string, body: string }
 */
app.post('/', async (c) => {
	const payload = await c.req.json<{ to?: string; subject?: string; body?: string }>().catch(() => ({} as any));

	if (!payload.to || !payload.subject || !payload.body) {
		throw new AppError(422, 'Validation failed: to, subject, and body are required');
	}

	const sent = await sendEmail(c.env, c.env.DB, payload.to, payload.subject, payload.body);

	return c.json({ sent }, 200);
});

/**
 * POST /api/v1/admin/email/test — send a test email to the current admin.
 */
app.post('/test', async (c) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) throw new AppError(401, 'The access token is invalid');

	const title = c.env.INSTANCE_TITLE || 'SiliconBeest';
	const html = `<h1>Test Email</h1><p>This is a test email from <strong>${title}</strong>. If you received this, SMTP is configured correctly.</p>`;

	const sent = await sendEmail(c.env, c.env.DB, currentUser.email, `[${title}] Test email`, html);

	return c.json({ sent }, 200);
});

export default app;
