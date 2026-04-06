import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { sendAccountWarning } from '../../../../../services/email';
import { sanitizeLocale } from '../../../../../utils/locales';
import {
	getAccountForModeration,
	unsuspendAccount,
	unsilenceAccount,
	enableAccount,
	unsensitizeAccount,
	addAccountWarning,
	getUserEmailByAccountId,
} from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/unsuspend — undo suspension.
 */
app.post('/:id/unsuspend', async (c) => {
	const id = c.req.param('id');
	await getAccountForModeration(id);

	const currentUser = c.get('currentUser')!;

	await unsuspendAccount(id);
	await addAccountWarning(currentUser.account_id, id, 'unsuspend', '');

	// Send notification email
	const user = await getUserEmailByAccountId(id);
	if (user?.email) {
		try {
			await sendAccountWarning(user.email, 'unsuspend', '', sanitizeLocale(user.locale));
		} catch { /* best-effort */ }
	}

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/unsilence — undo silence.
 */
app.post('/:id/unsilence', async (c) => {
	const id = c.req.param('id');
	await getAccountForModeration(id);

	const currentUser = c.get('currentUser')!;

	await unsilenceAccount(id);
	await addAccountWarning(currentUser.account_id, id, 'unsilence', '');

	const user = await getUserEmailByAccountId(id);
	if (user?.email) {
		try {
			await sendAccountWarning(user.email, 'unsilence', '', sanitizeLocale(user.locale));
		} catch { /* best-effort */ }
	}

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/enable — undo disable (unfreeze).
 */
app.post('/:id/enable', async (c) => {
	const id = c.req.param('id');
	await getAccountForModeration(id);

	const currentUser = c.get('currentUser')!;

	await enableAccount(id);
	await addAccountWarning(currentUser.account_id, id, 'enable', '');

	const user = await getUserEmailByAccountId(id);
	if (user?.email) {
		try {
			await sendAccountWarning(user.email, 'enable', '', sanitizeLocale(user.locale));
		} catch { /* best-effort */ }
	}

	return c.json({}, 200);
});

/**
 * POST /api/v1/admin/accounts/:id/unsensitize — remove sensitive flag.
 */
app.post('/:id/unsensitize', async (c) => {
	const id = c.req.param('id');
	await getAccountForModeration(id);

	const currentUser = c.get('currentUser')!;

	await unsensitizeAccount(id);
	await addAccountWarning(currentUser.account_id, id, 'unsensitize', '');

	const user = await getUserEmailByAccountId(id);
	if (user?.email) {
		try {
			await sendAccountWarning(user.email, 'unsensitize', '', sanitizeLocale(user.locale));
		} catch { /* best-effort */ }
	}

	return c.json({}, 200);
});

export default app;
