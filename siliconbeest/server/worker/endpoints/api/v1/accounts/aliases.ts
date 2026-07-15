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
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { getFedifyContext } from '../../../../federation/helpers/send';
import { getAliases, addAlias, removeAlias } from '../../../../services/account';

const app = new Hono<{ Variables: AppVariables }>();

// ── GET /aliases ──

app.get('/aliases', authRequired, requireScope('read:accounts'), async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const aliases = await getAliases(accountId);
	return c.json({ aliases });
});

// ── POST /aliases ──

app.post('/aliases', authRequired, requireScope('write:accounts'), async (c) => {
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
		const ctx = getFedifyContext(fed);
		// The domain part of the handle is case-insensitive (RFC 7565) — lowercase
		// it for the WebFinger resource; strict remotes match it case-sensitively.
		// Username casing is preserved. Split on the LAST '@' to match Fedify.
		const handle = alias.replace(/^@/, '');
		const at = handle.lastIndexOf('@');
		const normalizedAlias = at === -1
			? handle
			: `${handle.slice(0, at)}@${handle.slice(at + 1).toLowerCase()}`;
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

	const result = await addAlias(accountId, actorUri);
	c.set('contributionApplied', result.changed);
	return c.json({ aliases: result.aliases });
});

// ── DELETE /aliases ──

app.delete('/aliases', authRequired, requireScope('write:accounts'), async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const body = await c.req.json<{ alias: string }>().catch(() => null);

	if (!body?.alias) {
		return c.json({ error: 'Missing alias parameter' }, 422);
	}

	const result = await removeAlias(accountId, body.alias.trim());
	c.set('contributionApplied', result.changed);
	return c.json({ aliases: result.aliases });
});

export default app;
