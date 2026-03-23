import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { serializeAccount, serializeStatus, serializeTag } from '../../../utils/mastodonSerializer';
import type { AccountRow, StatusRow, TagRow } from '../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }

  const type = c.req.query('type');
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 40);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);
  const domain = c.env.INSTANCE_DOMAIN;

  let accounts: any[] = [];
  let statuses: any[] = [];
  let hashtags: any[] = [];

  const searchTerm = `%${q}%`;

  // Search accounts
  if (!type || type === 'accounts') {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM accounts
      WHERE (username LIKE ?1 OR display_name LIKE ?1)
        AND suspended_at IS NULL
      ORDER BY followers_count DESC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    accounts = (results ?? []).map((row: any) =>
      serializeAccount(row as AccountRow),
    );
  }

  // Search statuses
  if (!type || type === 'statuses') {
    const { results } = await c.env.DB.prepare(`
      SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
             a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
             a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
             a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
             a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
             a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
             a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
             a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
             a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id
      FROM statuses s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.content LIKE ?1
        AND s.visibility = 'public'
        AND s.deleted_at IS NULL
      ORDER BY s.id DESC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    statuses = (results ?? []).map((row: any) => {
      const accountRow: AccountRow = {
        id: row.a_id, username: row.a_username, domain: row.a_domain,
        display_name: row.a_display_name, note: row.a_note, uri: row.a_uri,
        url: row.a_url, avatar_url: row.a_avatar_url, avatar_static_url: row.a_avatar_static_url,
        header_url: row.a_header_url, header_static_url: row.a_header_static_url,
        locked: row.a_locked, bot: row.a_bot, discoverable: row.a_discoverable,
        manually_approves_followers: 0, statuses_count: row.a_statuses_count,
        followers_count: row.a_followers_count, following_count: row.a_following_count,
        last_status_at: row.a_last_status_at, created_at: row.a_created_at,
        updated_at: row.a_created_at, suspended_at: row.a_suspended_at,
        silenced_at: null, memorial: row.a_memorial, moved_to_account_id: row.a_moved_to_account_id,
      };
      return serializeStatus(row as StatusRow, { account: serializeAccount(accountRow) });
    });
  }

  // Search hashtags
  if (!type || type === 'hashtags') {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM tags
      WHERE name LIKE ?1
      ORDER BY name ASC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    hashtags = (results ?? []).map((row: any) => {
      const tag = serializeTag(row as TagRow);
      tag.url = `https://${domain}/tags/${tag.name}`;
      return tag;
    });
  }

  return c.json({ accounts, statuses, hashtags });
});

export default app;
