/**
 * Session management endpoints.
 * GET    /api/v1/auth/sessions       — list active sessions
 * DELETE /api/v1/auth/sessions/:id   — revoke a specific session
 * POST   /api/v1/auth/sessions/revoke_all — revoke all other sessions
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { listSessions, revokeSession, revokeAllOtherSessions } from '../../../../services/session';
import { AppError } from '../../../../middleware/errorHandler';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const tokenId = c.get('tokenId');
	const sessions = await listSessions(user.id, tokenId);
	return c.json(sessions);
});

app.delete('/:id', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const tokenId = c.req.param('id');

	const revoked = await revokeSession(user.id, tokenId);
	if (!revoked) {
		throw new AppError(404, 'Session not found');
	}

	return c.json({ success: true });
});

app.post('/revoke_all', authRequired, async (c) => {
	const user = c.get('currentUser')!;
	const currentTokenId = c.get('tokenId');
	if (!currentTokenId) {
		throw new AppError(401, 'Invalid session');
	}

	const count = await revokeAllOtherSessions(user.id, currentTokenId);
	return c.json({ revoked: count });
});

export default app;
