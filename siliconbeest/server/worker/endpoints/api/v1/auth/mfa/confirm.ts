/**
 * MFA confirm endpoint.
 * POST /api/v1/auth/mfa/confirm
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired } from '../../../../../middleware/auth';
import { verifyAndEnableMfa } from '../../../../../services/mfa';
import { AppError } from '../../../../../middleware/errorHandler';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const body = await c.req.json<{ code?: string }>().catch((): { code?: string } => ({}));
	const { code } = body;

	if (!code) {
		throw new AppError(422, 'TOTP code is required');
	}

	await verifyAndEnableMfa(user.id, code);

	return c.json({ success: true });
});

export default app;
