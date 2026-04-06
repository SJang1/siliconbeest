/**
 * Admin Relay API
 *
 * Manages ActivityPub relay subscriptions:
 * GET  /  — list all relays
 * POST /  — add a relay (sends Follow to relay inbox)
 * DELETE /:id — remove a relay (sends Undo(Follow), deletes record)
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { buildFollowActivity, buildUndoActivity } from '../../../../federation/helpers/build-activity';
import {
	listRelays,
	getRelay,
	checkRelayExists,
	createRelay,
	deleteRelay,
	getInstanceActorKey,
	type RelayRow,
} from '../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatRelay(row: RelayRow) {
	return {
		id: row.id,
		inbox_url: row.inbox_url,
		state: row.state,
		created_at: row.created_at,
	};
}

// -----------------------------------------------------------------------
// GET / — list all relays
// -----------------------------------------------------------------------

app.get('/', async (c) => {
	const results = await listRelays();
	return c.json(results.map(formatRelay));
});

// -----------------------------------------------------------------------
// POST / — add a relay
// -----------------------------------------------------------------------

app.post('/', async (c) => {
	const body = await c.req.json<{ inbox_url: string }>();
	if (!body.inbox_url) throw new AppError(422, 'inbox_url is required');

	// Validate URL format
	try {
		new URL(body.inbox_url);
	} catch {
		throw new AppError(422, 'inbox_url must be a valid URL');
	}

	// Check duplicate
	const exists = await checkRelayExists(body.inbox_url);
	if (exists) throw new AppError(409, 'Relay already exists');

	const domain = env.INSTANCE_DOMAIN;
	const actorUri = `https://${domain}/actor`;

	// Build Follow activity
	const followActivityJson = await buildFollowActivity(actorUri, body.inbox_url);
	const followActivityParsed = JSON.parse(followActivityJson);
	const followActivityId = followActivityParsed.id as string;

	// Create relay record
	const relay = await createRelay(body.inbox_url, followActivityId);

	// Ensure instance actor keypair exists (needed by queue consumer for signing)
	await getInstanceActorKey(domain);

	// Queue the delivery via federation queue
	await env.QUEUE_FEDERATION.send({
		type: 'deliver_activity',
		activity: followActivityParsed,
		inboxUrl: body.inbox_url,
		actorAccountId: '__instance__',
	});

	return c.json(formatRelay(relay), 200);
});

// -----------------------------------------------------------------------
// DELETE /:id — remove a relay
// -----------------------------------------------------------------------

app.delete('/:id', async (c) => {
	const id = c.req.param('id');

	const relay = await getRelay(id);

	const domain = env.INSTANCE_DOMAIN;
	const actorUri = `https://${domain}/actor`;

	// Send Undo(Follow) to the relay inbox
	if (relay.follow_activity_id) {
		const originalFollow: Record<string, unknown> = {
			'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
			id: relay.follow_activity_id,
			type: 'Follow',
			actor: actorUri,
			object: relay.inbox_url,
		};

		const undoJson = await buildUndoActivity(actorUri, originalFollow);

		await env.QUEUE_FEDERATION.send({
			type: 'deliver_activity',
			activity: JSON.parse(undoJson),
			inboxUrl: relay.inbox_url,
			actorAccountId: '__instance__',
		});
	}

	// Delete from DB
	await deleteRelay(id);

	return c.json({}, 200);
});

export default app;
