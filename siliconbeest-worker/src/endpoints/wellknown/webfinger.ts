import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /.well-known/webfinger?resource=acct:user@domain
app.get('/', async (c) => {
	const resource = c.req.query('resource');

	if (!resource) {
		return c.json({ error: 'Missing resource parameter' }, 400);
	}

	// Parse acct: URI
	const acctMatch = resource.match(/^acct:([^@]+)@(.+)$/i);
	if (!acctMatch) {
		return c.json({ error: 'Invalid resource format. Expected acct:user@domain' }, 400);
	}

	const [, username, domain] = acctMatch;
	const instanceDomain = c.env.INSTANCE_DOMAIN;

	// Only respond for our own domain
	if (domain.toLowerCase() !== instanceDomain.toLowerCase()) {
		return c.json({ error: 'Resource not found' }, 404);
	}

	// Instance actor: domain itself as username (e.g. acct:domain@domain)
	if (username!.toLowerCase() === instanceDomain.toLowerCase()) {
		const actorUri = `https://${instanceDomain}/actor`;
		return c.json(
			{
				subject: `acct:${instanceDomain}@${instanceDomain}`,
				aliases: [actorUri],
				links: [
					{ rel: 'self', type: 'application/activity+json', href: actorUri },
				],
			},
			200,
			{
				'Content-Type': 'application/jrd+json; charset=utf-8',
				'Cache-Control': 'max-age=259200, public',
				'Access-Control-Allow-Origin': '*',
			},
		);
	}

	// Query local account
	const account = await c.env.DB.prepare(
		`SELECT id, username FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(username!.toLowerCase())
		.first();

	if (!account) {
		return c.json({ error: 'Resource not found' }, 404);
	}

	const actorUri = `https://${instanceDomain}/users/${account.username}`;
	const profileUrl = `https://${instanceDomain}/@${account.username}`;

	return c.json(
		{
			subject: `acct:${account.username}@${instanceDomain}`,
			aliases: [actorUri, profileUrl],
			links: [
				{
					rel: 'self',
					type: 'application/activity+json',
					href: actorUri,
				},
				{
					rel: 'http://webfinger.net/rel/profile-page',
					type: 'text/html',
					href: profileUrl,
				},
				{
					rel: 'http://ostatus.org/schema/1.0/subscribe',
					template: `https://${instanceDomain}/authorize_interaction?uri={uri}`,
				},
			],
		},
		200,
		{
			'Content-Type': 'application/jrd+json; charset=utf-8',
			'Cache-Control': 'max-age=259200, public',
		},
	);
});

export default app;
