/**
 * MFA disable endpoint.
 * POST /api/v1/auth/mfa/disable
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired } from '../../../../../middleware/auth';
import { disableMfa } from '../../../../../services/mfa';
import { AppError } from '../../../../../middleware/errorHandler';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const body = await c.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
	const { password } = body;

	if (!password) {
		throw new AppError(422, 'Password is required to disable 2FA');
	}

	await disableMfa(user.id, user.email, password);

	return c.json({ success: true });
});

export default app;
