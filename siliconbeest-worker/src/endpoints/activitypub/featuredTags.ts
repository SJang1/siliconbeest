/**
 * ActivityPub Featured Tags Collection
 *
 * Returns an OrderedCollection of featured hashtags for a given actor.
 * Currently returns an empty collection (can be populated later).
 * GET /users/:username/collections/tags
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import type { AccountRow } from '../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username/collections/tags', async (c) => {
	const username = c.req.param('username');
	const domain = c.env.INSTANCE_DOMAIN;

	const account = await c.env.DB.prepare(
		`SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(username)
		.first<{ id: string }>();

	if (!account) {
		return c.json({ error: 'Record not found' }, 404);
	}

	const actorUri = `https://${domain}/users/${username}`;
	const collectionUri = `${actorUri}/collections/tags`;

	return c.json(
		{
			'@context': ['https://www.w3.org/ns/activitystreams'],
			id: collectionUri,
			type: 'OrderedCollection',
			totalItems: 0,
			orderedItems: [],
		},
		200,
		{ 'Content-Type': 'application/activity+json; charset=utf-8', 'Vary': 'Accept' },
	);
});

export default app;
