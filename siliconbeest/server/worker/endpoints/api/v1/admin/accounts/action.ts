import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { sendAccountWarning } from '../../../../../services/email';
import { sanitizeLocale } from '../../../../../utils/locales';
import {
	getAccountForModeration,
	sensitizeAccount,
	disableAccount,
	silenceAccount,
	suspendAccount,
	addAccountWarning,
	resolveReport,
	getUserEmailByAccountId,
} from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/action — take moderation action on an account.
 *
 * Body:
 *   type: none | sensitive | disable | silence | suspend
 *   report_id?: string
 *   warning_preset_id?: string
 *   text?: string
 *   send_email_notification?: boolean  (default true)
 */
app.post('/:id/action', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{
		type: string;
		report_id?: string;
		warning_preset_id?: string;
		text?: string;
		send_email_notification?: boolean;
	}>();

	const actionType = body.type;
	if (!actionType || !['none', 'warn', 'sensitive', 'disable', 'silence', 'suspend'].includes(actionType)) {
		throw new AppError(400, 'Invalid action type');
	}

	// Verify the target account exists
	const account = await getAccountForModeration(id);

	const currentUser = c.get('currentUser')!;
	const sendEmail = body.send_email_notification !== false; // default true
	const warningText = body.text || '';

	switch (actionType) {
		case 'sensitive':
			await sensitizeAccount(id);
			break;

		case 'disable':
			await disableAccount(id);
			break;

		case 'silence':
			await silenceAccount(id);
			break;

		case 'suspend':
			await suspendAccount(id);
			// Enqueue Delete(Actor) activity for federation (local accounts only)
			if (!account.domain) {
				const actorUri = (account.uri as string) || `https://${env.INSTANCE_DOMAIN}/users/${account.username}`;
				await env.QUEUE_FEDERATION.send({
					type: 'deliver_activity_fanout',
					actorAccountId: id as string,
					activity: {
						'@context': ['https://www.w3.org/ns/activitystreams'],
						id: `${actorUri}#delete`,
						type: 'Delete',
						actor: actorUri,
						object: actorUri,
						to: ['https://www.w3.org/ns/activitystreams#Public'],
					},
				});
			}
			break;

		case 'none':
		default:
			// No action — used to just send a warning
			break;
	}

	// Create account_warnings record for every action
	await addAccountWarning(currentUser.account_id, id, actionType, warningText, body.report_id);

	// Send email notification to local users only (domain IS NULL means local)
	if (sendEmail && !account.domain) {
		const user = await getUserEmailByAccountId(id);
		if (user?.email) {
			try {
				await sendAccountWarning(user.email, actionType, warningText, sanitizeLocale(user.locale as string | null));
			} catch {
				// Email failure should not block the action
			}
		}
	}

	// If a report_id was provided, resolve it
	if (body.report_id) {
		await resolveReport(body.report_id, currentUser.account_id);
	}

	return c.json({}, 200);
});

export default app;
