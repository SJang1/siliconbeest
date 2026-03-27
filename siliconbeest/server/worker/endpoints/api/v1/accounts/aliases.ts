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

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ── Helpers ──

/**
 * Parse the also_known_as JSON column into a string array.
 */
function parseAliases(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// ── GET /aliases ──

app.get('/aliases', authRequired, async (c) => {
	const accountId = c.get('currentUser')!.account_id;

	const account = await c.env.DB.prepare(
		`SELECT also_known_as FROM accounts WHERE id = ?1 LIMIT 1`,
	)
		.bind(accountId)
		.first<{ also_known_as: string | null }>();

	if (!account) {
		return c.json({ error: 'Account not found' }, 404);
	}

	const aliases = parseAliases(account.also_known_as);
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

	// Read current aliases
	const account = await c.env.DB.prepare(
		`SELECT also_known_as FROM accounts WHERE id = ?1 LIMIT 1`,
	)
		.bind(accountId)
		.first<{ also_known_as: string | null }>();

	if (!account) {
		return c.json({ error: 'Account not found' }, 404);
	}

	const aliases = parseAliases(account.also_known_as);

	// Check if already present
	if (aliases.includes(actorUri)) {
		return c.json({ aliases });
	}

	aliases.push(actorUri);

	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`UPDATE accounts SET also_known_as = ?1, updated_at = ?2 WHERE id = ?3`,
	)
		.bind(JSON.stringify(aliases), now, accountId)
		.run();

	return c.json({ aliases });
});

// ── DELETE /aliases ──

app.delete('/aliases', authRequired, async (c) => {
	const accountId = c.get('currentUser')!.account_id;
	const body = await c.req.json<{ alias: string }>().catch(() => null);

	if (!body?.alias) {
		return c.json({ error: 'Missing alias parameter' }, 422);
	}

	const alias = body.alias.trim();

	const account = await c.env.DB.prepare(
		`SELECT also_known_as FROM accounts WHERE id = ?1 LIMIT 1`,
	)
		.bind(accountId)
		.first<{ also_known_as: string | null }>();

	if (!account) {
		return c.json({ error: 'Account not found' }, 404);
	}

	const aliases = parseAliases(account.also_known_as);
	const filtered = aliases.filter((a) => a !== alias);

	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`UPDATE accounts SET also_known_as = ?1, updated_at = ?2 WHERE id = ?3`,
	)
		.bind(filtered.length > 0 ? JSON.stringify(filtered) : null, now, accountId)
		.run();

	return c.json({ aliases: filtered });
});

export default app;
