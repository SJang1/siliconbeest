import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { serializeActor } from '../../federation/actorSerializer';
import type { AccountRow, ActorKeyRow, CustomEmojiRow } from '../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * Extract custom emoji shortcodes from text (e.g. :custom_emoji:).
 */
function extractEmojiShortcodes(text: string): string[] {
  const matches = text.match(/:([a-zA-Z0-9_]+):/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/:/g, '')))];
}

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT * FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<AccountRow>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  // C2: Return Tombstone for suspended actors
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

  const actorKey = await c.env.DB.prepare(`
    SELECT * FROM actor_keys
    WHERE account_id = ?1
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(account.id).first<ActorKeyRow>();

  if (!actorKey) {
    return c.json({ error: 'Actor key not found' }, 500);
  }

  // Look up custom emojis used in the display name or bio
  const textToScan = `${account.display_name || ''} ${account.note || ''}`;
  const shortcodes = extractEmojiShortcodes(textToScan);
  let customEmojis: CustomEmojiRow[] = [];

  if (shortcodes.length > 0) {
    const placeholders = shortcodes.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM custom_emojis WHERE shortcode IN (${placeholders}) AND domain IS NULL`,
    ).bind(...shortcodes).all();
    customEmojis = (results ?? []) as unknown as CustomEmojiRow[];
  }

  const actor = serializeActor(account, actorKey, domain, { customEmojis });

  return c.json(actor, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
    'Cache-Control': 'max-age=180, public',
    'Vary': 'Accept',
  });
});

export default app;
