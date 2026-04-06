/**
 * MFA setup endpoint.
 * POST /api/v1/auth/mfa/setup
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired } from '../../../../../middleware/auth';
import { setupMfa } from '../../../../../services/mfa';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const result = await setupMfa(user.id, user.email);
	return c.json(result);
});

export default app;
