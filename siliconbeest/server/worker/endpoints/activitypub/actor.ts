/**
 * Actor Endpoint — Tombstone fallback only
 *
 * Fedify's actor dispatcher handles normal actor requests at /users/{identifier}.
 * This Hono route only handles the suspended-actor Tombstone case (HTTP 410),
 * which Fedify cannot express via its actor dispatcher return type.
 *
 * When Fedify's dispatcher returns null for a suspended actor, the request
 * falls through to Hono and this route catches it.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import type { AccountRow } from '../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT id, username, suspended_at FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<Pick<AccountRow, 'id' | 'username' | 'suspended_at'>>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  // Return Tombstone for suspended actors
  if (account.suspended_at) {
    const actorUri = `https://${domain}/users/${username}`;
    return c.json({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: actorUri,
      type: 'Tombstone',
      formerType: 'Person',
      deleted: account.suspended_at,
    }, 410, {
      'Content-Type': 'application/activity+json; charset=utf-8',
      'Vary': 'Accept',
    });
  }

  // Non-suspended actors should have been handled by Fedify.
  // If we reach here, something went wrong in the Fedify dispatcher.
  return c.json({ error: 'Record not found' }, 404);
});

export default app;
