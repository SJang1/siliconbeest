import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { serializeAccount, serializeStatus } from '../../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import type { AccountRow, StatusRow } from '../../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * GET /api/v1/trends/statuses — Return trending statuses.
 * Public statuses from last 7 days with most favourites+reblogs.
 */
app.get('/', authOptional, async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 40);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);

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
    WHERE s.created_at > datetime('now', '-7 days')
      AND s.deleted_at IS NULL
      AND s.visibility = 'public'
      AND s.reblog_of_id IS NULL
    ORDER BY (s.favourites_count + s.reblogs_count) DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const statusIds = (results ?? []).map((r: any) => r.id as string);
  const currentAccount = c.get('currentAccount');
  const enrichments = await enrichStatuses(
    c.env.DB,
    c.env.INSTANCE_DOMAIN,
    statusIds,
    currentAccount?.id ?? null,
  );

  const statuses = (results ?? []).map((row: any) => {
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
    const e = enrichments.get(row.id);
    return serializeStatus(row as StatusRow, {
      account: serializeAccount(accountRow, { emojis: e?.accountEmojis }),
      mediaAttachments: e?.mediaAttachments,
      mentions: e?.mentions,
      favourited: e?.favourited,
      reblogged: e?.reblogged,
      bookmarked: e?.bookmarked,
      card: e?.card,
      emojis: e?.emojis,
    });
  });

  return c.json(statuses);
});

export default app;
