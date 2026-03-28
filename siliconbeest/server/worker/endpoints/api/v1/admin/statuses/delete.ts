import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * DELETE /api/v1/admin/statuses/:id — soft-delete a status.
 *
 * Sets deleted_at on the status row. If the author is a local user,
 * enqueues a Delete(Tombstone) activity to federate the deletion.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');

	// Fetch the status
	const status = await c.env.DB.prepare('SELECT id, uri, account_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
		.bind(id)
		.first();
	if (!status) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();

	// Soft delete
	await c.env.DB.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, id).run();

	// Check if the author is a local account (domain IS NULL)
	const account = await c.env.DB.prepare('SELECT id, username, domain, uri FROM accounts WHERE id = ?1')
		.bind(status.account_id)
		.first();

	if (account && !account.domain) {
		// Local author — federate Delete(Tombstone)
		const statusUri = status.uri as string;
		const actorUri = (account.uri as string) || `https://${c.env.INSTANCE_DOMAIN}/users/${account.username}`;
		await c.env.QUEUE_FEDERATION.send({
			type: 'deliver_activity_fanout',
			actorAccountId: account.id as string,
			activity: {
				'@context': ['https://www.w3.org/ns/activitystreams'],
				id: `${statusUri}#delete`,
				type: 'Delete',
				actor: actorUri,
				object: {
					id: statusUri,
					type: 'Tombstone',
				},
				to: ['https://www.w3.org/ns/activitystreams#Public'],
			},
		});
	}

	return c.json({}, 200);
});

export default app;
