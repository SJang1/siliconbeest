import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';
import { generateUlid } from '../../../../../utils/ulid';
import { sendAccountWarning } from '../../../../../services/email';

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
	const account = await c.env.DB.prepare('SELECT id, username, domain, uri FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();
	const sendEmail = body.send_email_notification !== false; // default true
	const warningText = body.text || '';

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

	// Create account_warnings record for every action
	const warningId = generateUlid();
	await c.env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, report_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
	)
		.bind(warningId, currentUser.account_id, id, actionType, warningText, body.report_id || null, now)
		.run();

	// Send email notification to local users only (domain IS NULL means local)
	if (sendEmail && !account.domain) {
		const user = await c.env.DB.prepare('SELECT email FROM users WHERE account_id = ?1').bind(id).first<{ email: string | null }>();
		if (user?.email) {
			try {
				await sendAccountWarning(c.env, user.email, actionType, warningText);
			} catch {
				// Email failure should not block the action
			}
		}
	}

	// If a report_id was provided, resolve it
	if (body.report_id) {
		await c.env.DB.prepare('UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2 WHERE id = ?3')
			.bind(now, currentUser.account_id, body.report_id)
			.run();
	}

	return c.json({}, 200);
});

export default app;
