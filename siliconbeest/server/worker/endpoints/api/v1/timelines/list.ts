import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { parsePaginationParams, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount, serializeStatus } from '../../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import { getListTimeline } from '../../../../services/timeline';
import type { AccountRow, StatusRow } from '../../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:listId', authRequired, async (c) => {
  const listId = c.req.param('listId');
  const account = c.get('currentAccount')!;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const allRows = await getListTimeline(c.env.DB, listId, account.id, {
    maxId: pag.maxId,
    sinceId: pag.sinceId,
    minId: pag.minId,
    limit: pag.limit,
  });

  const statusIds = allRows.map((r) => r.id as string);
  const enrichments = await enrichStatuses(c.env.DB, c.env.INSTANCE_DOMAIN, statusIds, account.id, c.env.CACHE);

  const statuses = allRows.map((row: any) => {
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
      emoji_tags: row.a_emoji_tags || null,
    };
    const e = enrichments.get(row.id);
    return serializeStatus(row as StatusRow, {
      account: serializeAccount(accountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
      mediaAttachments: e?.mediaAttachments,
      mentions: e?.mentions,
      favourited: e?.favourited,
      reblogged: e?.reblogged,
      bookmarked: e?.bookmarked,
      card: e?.card, poll: e?.poll,
      emojis: e?.emojis,
    });
  });

  // Reverse when using min_id (ASC query)
  if (pag.minId) statuses.reverse();

  const baseUrl = `https://${c.env.INSTANCE_DOMAIN}/api/v1/timelines/list/${listId}`;
  const link = buildLinkHeader(baseUrl, statuses, pag.limit);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(statuses, 200, headers);
});

export default app;
