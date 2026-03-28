import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';
import { generateUlid } from '../../../../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/unsuspend — undo suspension.
 */
app.post('/:id/unsuspend', async (c) => {
	const id = c.req.param('id');

	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();

	await c.env.DB.prepare('UPDATE accounts SET suspended_at = NULL WHERE id = ?1').bind(id).run();

	const warningId = generateUlid();
	await c.env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
	)
		.bind(warningId, currentUser.account_id, id, 'unsuspend', '', now)
		.run();

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/unsilence — undo silence.
 */
app.post('/:id/unsilence', async (c) => {
	const id = c.req.param('id');

	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();

	await c.env.DB.prepare('UPDATE accounts SET silenced_at = NULL WHERE id = ?1').bind(id).run();

	const warningId = generateUlid();
	await c.env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
	)
		.bind(warningId, currentUser.account_id, id, 'unsilence', '', now)
		.run();

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/enable — undo disable (unfreeze).
 */
app.post('/:id/enable', async (c) => {
	const id = c.req.param('id');

	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();

	await c.env.DB.prepare('UPDATE users SET disabled = 0 WHERE account_id = ?1').bind(id).run();

	const warningId = generateUlid();
	await c.env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
	)
		.bind(warningId, currentUser.account_id, id, 'enable', '', now)
		.run();

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/unsensitize — remove sensitive flag.
 */
app.post('/:id/unsensitize', async (c) => {
	const id = c.req.param('id');

	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();

	await c.env.DB.prepare('UPDATE accounts SET sensitized_at = NULL WHERE id = ?1').bind(id).run();

	const warningId = generateUlid();
	await c.env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
	)
		.bind(warningId, currentUser.account_id, id, 'unsensitize', '', now)
		.run();

	return c.json({}, 200);
});

export default app;
