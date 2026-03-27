/**
 * Account Migration API
 *
 * Initiates an account migration (Move) from the current account to
 * a target account. The target account must have already added this
 * account's URI to its alsoKnownAs list.
 *
 * POST /api/v1/accounts/migration
 *   Body: { target_acct: "user@newserver.com" }
 *
 * Flow:
 * 1. WebFinger resolve target_acct to actor URI
 * 2. Fetch target actor document
 * 3. Verify target's alsoKnownAs contains our account URI
 * 4. Update moved_to_account_id + moved_at on local account
 * 5. Build Move activity and fanout to followers
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { resolveRemoteAccount } from '../../../../federation/resolveRemoteAccount';
import { sendToFollowers, getFedifyContext } from '../../../../federation/helpers/send';
import { isActor } from '@fedify/fedify/vocab';
import { Move } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/migration', authRequired, async (c) => {
	const currentUser = c.get('currentUser')!;
	const accountId = currentUser.account_id;
	const domain = c.env.INSTANCE_DOMAIN;

	const body = await c.req.json<{ target_acct: string }>().catch(() => null);

	if (!body?.target_acct) {
		return c.json({ error: 'Missing target_acct parameter' }, 422);
	}

	const targetAcct = body.target_acct.trim();

	// 1. WebFinger resolve target via Fedify
	const fed = c.get('federation');
	const ctx = getFedifyContext(fed, c.env);
	const wfResult = await ctx.lookupWebFinger(`acct:${targetAcct.replace(/^@/, '')}`);
	const selfLink = wfResult?.links?.find(
		(link) =>
			link.rel === 'self' &&
			(link.type === 'application/activity+json' ||
				link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
			link.href,
	);
	if (!selfLink?.href) {
		return c.json({ error: 'Could not resolve target account via WebFinger' }, 422);
	}

	const targetActorUri = selfLink.href;

	// 2. Fetch target actor document via Fedify
	const targetActor = await ctx.lookupObject(targetActorUri);
	if (!targetActor || !isActor(targetActor) || !targetActor.id) {
		return c.json({ error: 'Could not fetch target actor document' }, 422);
	}

	// 3. Verify alsoKnownAs bidirectional link
	const account = await c.env.DB.prepare(
		`SELECT username, uri FROM accounts WHERE id = ?1 LIMIT 1`,
	)
		.bind(accountId)
		.first<{ username: string; uri: string }>();

	if (!account) {
		return c.json({ error: 'Account not found' }, 404);
	}

	const ourUri = account.uri;
	const alsoKnownAs: string[] = targetActor.aliasIds
		? Array.from(targetActor.aliasIds).map((u: URL) => u.href)
		: [];

	if (!alsoKnownAs.includes(ourUri)) {
		return c.json(
			{ error: 'Target account does not list this account in alsoKnownAs. Add an alias on the target account first.' },
			422,
		);
	}

	// 4. Resolve or create the target account in our DB
	const targetAccountId = await resolveRemoteAccount(targetActorUri, c.env);
	if (!targetAccountId) {
		return c.json({ error: 'Could not resolve target account' }, 422);
	}

	// Update moved_to_account_id + moved_at
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`UPDATE accounts SET moved_to_account_id = ?1, moved_at = ?2, updated_at = ?3 WHERE id = ?4`,
	)
		.bind(targetAccountId, now, now, accountId)
		.run();

	// 5. Build Move activity and fanout to followers
	const move = new Move({
		id: new URL(`${ourUri}#moves/${generateUlid()}`),
		actor: new URL(ourUri),
		object: new URL(ourUri),
		target: new URL(targetActorUri),
	});
	await sendToFollowers(fed, c.env, account.username, move);

	console.log(`[migration] Account ${ourUri} moved to ${targetActorUri}`);

	return c.json({ message: 'Migration initiated', target: targetActorUri });
});

export default app;
