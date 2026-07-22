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
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../types';
import type { AccountRow } from '../../types/db';
import { canAccountOriginateFederationActivity } from '../../services/permissions';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const domain = env.INSTANCE_DOMAIN;

  const account = await env.DB_META_C000.prepare(`
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

  if (!await canAccountOriginateFederationActivity(account.id)) {
    return c.json({ error: 'Record not found' }, 404);
  }

  // Non-AP requests (browsers) — redirect to the profile page
  return c.redirect(`https://${domain}/@${account.username}`);
});

export default app;
