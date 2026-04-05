/**
 * Alias Management API
 *
 * Manages the `alsoKnownAs` list for the authenticated account.
 * This is a prerequisite for account migration — the target account
 * must add the source account as an alias before the source can
 * initiate a Move.
 *
 * GET  /api/v1/accounts/aliases       — list current aliases
 * POST /api/v1/accounts/aliases       — add an alias (WebFinger verified)
 * DELETE /api/v1/accounts/aliases     — remove an alias
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { getFedifyContext } from '../../../../federation/helpers/send';
import { getAliases, addAlias, removeAlias } from '../../../../services/account';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ── GET /aliases ──

app.get('/aliases', authRequired, async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const aliases = await getAliases(c.env.DB, accountId);
	return c.json({ aliases });
});

// ── POST /aliases ──

app.post('/aliases', authRequired, async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const body = await c.req.json<{ alias: string }>().catch(() => null);

	if (!body?.alias) {
		return c.json({ error: 'Missing alias parameter' }, 422);
	}

	const alias = body.alias.trim();

	// Determine if the alias is already a full URI or an acct-style handle
	let actorUri: string;
	if (alias.startsWith('https://')) {
		actorUri = alias;
	} else {
		// WebFinger resolve to get the actor URI via Fedify
		const fed = c.get('federation');
		const ctx = getFedifyContext(fed, c.env);
		const normalizedAlias = alias.replace(/^@/, '');
		const wfResult = await ctx.lookupWebFinger(`acct:${normalizedAlias}`);
		const selfLink = wfResult?.links?.find(
			(link) =>
				link.rel === 'self' &&
				(link.type === 'application/activity+json' ||
					link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
				link.href,
		);
		if (!selfLink?.href) {
			return c.json({ error: 'Could not resolve alias via WebFinger' }, 422);
		}
		actorUri = selfLink.href;
	}

	const aliases = await addAlias(c.env.DB, accountId, actorUri);
	return c.json({ aliases });
});

// ── DELETE /aliases ──

app.delete('/aliases', authRequired, async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const body = await c.req.json<{ alias: string }>().catch(() => null);

	if (!body?.alias) {
		return c.json({ error: 'Missing alias parameter' }, 422);
	}

	const aliases = await removeAlias(c.env.DB, accountId, body.alias.trim());
	return c.json({ aliases });
});

export default app;
