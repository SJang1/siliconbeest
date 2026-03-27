import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/action — take moderation action on an account.
 *
 * Body:
 *   type: none | sensitive | disable | silence | suspend
 *   report_id?: string
 *   warning_preset_id?: string
 *   text?: string
 *   send_email_notification?: boolean
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
	if (!actionType || !['none', 'sensitive', 'disable', 'silence', 'suspend'].includes(actionType)) {
		throw new AppError(400, 'Invalid action type');
	}

	// Verify the target account exists
	const account = await c.env.DB.prepare('SELECT id, username, domain, uri FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();

	switch (actionType) {
		case 'sensitive':
			await c.env.DB.prepare('UPDATE accounts SET sensitized_at = ?1 WHERE id = ?2').bind(now, id).run();
			break;

		case 'disable':
			await c.env.DB.prepare('UPDATE users SET disabled = 1 WHERE account_id = ?1').bind(id).run();
			break;

		case 'silence':
			await c.env.DB.prepare('UPDATE accounts SET silenced_at = ?1 WHERE id = ?2').bind(now, id).run();
			break;

		case 'suspend':
			await c.env.DB.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2').bind(now, id).run();
			// Enqueue Delete(Actor) activity for federation (local accounts only)
			if (!account.domain) {
				const actorUri = (account.uri as string) || `https://${c.env.INSTANCE_DOMAIN}/users/${account.username}`;
				await c.env.QUEUE_FEDERATION.send({
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

	// If a report_id was provided, resolve it
	if (body.report_id) {
		const currentUser = c.get('currentUser')!;
		await c.env.DB.prepare('UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2 WHERE id = ?3')
			.bind(now, currentUser.account_id, body.report_id)
			.run();
	}

	return c.json({}, 200);
});

export default app;
