import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { fetchAccountEmojis, getAccountEmojis } from '../../../../utils/statusEnrichment';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/search', authRequired, async (c) => {
  const query = c.req.query();
  const q = (query.q || '').trim();
  const limit = Math.min(parseInt(query.limit || '40', 10) || 40, 80);
  const resolve = query.resolve === 'true';
  const following = query.following === 'true';
  const domain = c.env.INSTANCE_DOMAIN;
  const currentAccountId = c.get('currentUser')!.account_id;

  if (!q) return c.json([]);

  let sql: string;
  const params: unknown[] = [];

  if (following) {
    sql = `
      SELECT a.* FROM accounts a
      JOIN follows f ON f.target_account_id = a.id
      WHERE f.account_id = ?
        AND (a.username LIKE ? OR a.display_name LIKE ?)
      ORDER BY a.username ASC
      LIMIT ?
    `;
    params.push(currentAccountId, `%${q}%`, `%${q}%`, limit);
  } else {
    sql = `
      SELECT * FROM accounts
      WHERE (username LIKE ? OR display_name LIKE ?)
      ORDER BY
        CASE WHEN domain IS NULL THEN 0 ELSE 1 END,
        username ASC
      LIMIT ?
    `;
    params.push(`%${q}%`, `%${q}%`, limit);
  }

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();

  // Batch-fetch account emojis
  const domainTexts = new Map<string, string[]>();
  for (const row of results as Record<string, unknown>[]) {
    const dk = (row.domain as string) || '__local__';
    if (!domainTexts.has(dk)) domainTexts.set(dk, []);
    domainTexts.get(dk)!.push((row.display_name as string) || '', (row.note as string) || '');
  }
  const emojiMaps = new Map<string, Map<string, any>>();
  const emojiPromises: Promise<void>[] = [];
  for (const [dk, texts] of domainTexts) {
    emojiPromises.push(
      fetchAccountEmojis(c.env.DB, texts, dk === '__local__' ? null : dk).then((m) => {
        if (m.size > 0) emojiMaps.set(dk, m);
      }),
    );
  }
  await Promise.all(emojiPromises);

  const accounts = (results as Record<string, unknown>[]).map((row) => {
    const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
    const dk = (row.domain as string) || '__local__';
    const em = emojiMaps.get(dk);
    const acctEmojis = em ? getAccountEmojis(em, (row.display_name as string) || '', (row.note as string) || '') : [];
    return {
      id: row.id as string,
      username: row.username as string,
      acct,
      display_name: (row.display_name as string) || '',
      locked: !!(row.locked),
      bot: !!(row.bot),
      discoverable: !!(row.discoverable),
      group: false,
      created_at: row.created_at as string,
      note: (row.note as string) || '',
      url: (row.url as string) || `https://${domain}/@${row.username}`,
      uri: row.uri as string,
      avatar: (row.avatar_url as string) || null,
      avatar_static: (row.avatar_static_url as string) || null,
      header: (row.header_url as string) || null,
      header_static: (row.header_static_url as string) || null,
      followers_count: (row.followers_count as number) || 0,
      following_count: (row.following_count as number) || 0,
      statuses_count: (row.statuses_count as number) || 0,
      last_status_at: (row.last_status_at as string) || null,
      emojis: acctEmojis,
      fields: [],
    };
  });

  return c.json(accounts);
});

export default app;
