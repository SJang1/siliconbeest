import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount, serializeNotification } from '../../../../utils/mastodonSerializer';
import type { AccountRow, NotificationRow } from '../../../../types/db';
import { enrichStatuses } from '../../../../utils/statusEnrichment';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'n.id');

  const conditions: string[] = ['n.account_id = ?'];
  const binds: (string | number)[] = [account.id];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  // Filter by types[]
  const types = c.req.queries('types[]');
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(', ');
    conditions.push(`n.type IN (${placeholders})`);
    binds.push(...types);
  }

  // Filter by exclude_types[]
  const excludeTypes = c.req.queries('exclude_types[]');
  if (excludeTypes && excludeTypes.length > 0) {
    const placeholders = excludeTypes.map(() => '?').join(', ');
    conditions.push(`n.type NOT IN (${placeholders})`);
    binds.push(...excludeTypes);
  }

  const sql = `
    SELECT n.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
           a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
           a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
           a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
           a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
           a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
           a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
           a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
           a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id
    FROM notifications n
    JOIN accounts a ON a.id = n.from_account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const rows = results ?? [];

  // Collect status IDs that need fetching
  const statusIds = rows
    .filter((row: any) => row.status_id)
    .map((row: any) => row.status_id as string);
  const uniqueStatusIds = [...new Set(statusIds)];

  // Batch-fetch statuses with their accounts
  const statusMap = new Map<string, any>();
  if (uniqueStatusIds.length > 0) {
    const statusPlaceholders = uniqueStatusIds.map(() => '?').join(',');
    const { results: statusRows } = await c.env.DB.prepare(
      `SELECT s.id, s.uri, s.url, s.content, s.visibility, s.sensitive,
              s.content_warning, s.language, s.created_at, s.in_reply_to_id,
              s.in_reply_to_account_id, s.reblogs_count, s.favourites_count,
              s.replies_count, s.edited_at,
              sa.id AS sa_id, sa.username AS sa_username, sa.domain AS sa_domain,
              sa.display_name AS sa_display_name, sa.note AS sa_note,
              sa.uri AS sa_uri, sa.url AS sa_url,
              sa.avatar_url AS sa_avatar_url, sa.avatar_static_url AS sa_avatar_static_url,
              sa.header_url AS sa_header_url, sa.header_static_url AS sa_header_static_url,
              sa.locked AS sa_locked, sa.bot AS sa_bot, sa.discoverable AS sa_discoverable,
              sa.followers_count AS sa_followers_count, sa.following_count AS sa_following_count,
              sa.statuses_count AS sa_statuses_count, sa.last_status_at AS sa_last_status_at,
              sa.created_at AS sa_created_at
       FROM statuses s
       JOIN accounts sa ON sa.id = s.account_id
       WHERE s.id IN (${statusPlaceholders}) AND s.deleted_at IS NULL`,
    ).bind(...uniqueStatusIds).all();

    // Get enrichments (media, interactions)
    const enrichments = await enrichStatuses(c.env.DB, domain, uniqueStatusIds, account.id);

    for (const sr of statusRows ?? []) {
      const sId = sr.id as string;
      const saAcct = sr.sa_domain
        ? `${sr.sa_username}@${sr.sa_domain}`
        : (sr.sa_username as string);
      const e = enrichments.get(sId);

      statusMap.set(sId, {
        id: sId,
        uri: sr.uri,
        url: sr.url || null,
        created_at: sr.created_at,
        content: sr.content || '',
        visibility: sr.visibility || 'public',
        sensitive: !!sr.sensitive,
        spoiler_text: (sr.content_warning as string) || '',
        language: sr.language || null,
        in_reply_to_id: sr.in_reply_to_id || null,
        in_reply_to_account_id: sr.in_reply_to_account_id || null,
        reblogs_count: sr.reblogs_count || 0,
        favourites_count: sr.favourites_count || 0,
        replies_count: sr.replies_count || 0,
        edited_at: sr.edited_at || null,
        favourited: e?.favourited ?? false,
        reblogged: e?.reblogged ?? false,
        bookmarked: e?.bookmarked ?? false,
        muted: false,
        pinned: false,
        reblog: null,
        poll: null,
        card: e?.card ?? null,
        application: null,
        text: null,
        filtered: [],
        media_attachments: e?.mediaAttachments ?? [],
        mentions: e?.mentions ?? [],
        tags: [],
        emojis: [],
        account: {
          id: sr.sa_id,
          username: sr.sa_username,
          acct: saAcct,
          display_name: (sr.sa_display_name as string) || '',
          locked: !!sr.sa_locked,
          bot: !!sr.sa_bot,
          discoverable: !!sr.sa_discoverable,
          group: false,
          created_at: sr.sa_created_at,
          note: (sr.sa_note as string) || '',
          url: (sr.sa_url as string) || `https://${domain}/@${sr.sa_username}`,
          uri: sr.sa_uri,
          avatar: (sr.sa_avatar_url as string) || null,
          avatar_static: (sr.sa_avatar_static_url as string) || null,
          header: (sr.sa_header_url as string) || null,
          header_static: (sr.sa_header_static_url as string) || null,
          followers_count: sr.sa_followers_count || 0,
          following_count: sr.sa_following_count || 0,
          statuses_count: sr.sa_statuses_count || 0,
          last_status_at: sr.sa_last_status_at || null,
          emojis: [],
          fields: [],
        },
      });
    }
  }

  const notifications = rows.map((row: any) => {
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
    const notifRow: NotificationRow = {
      id: row.id, account_id: row.account_id, from_account_id: row.from_account_id,
      type: row.type, status_id: row.status_id, read: row.read, created_at: row.created_at,
    };

    const statusObj = row.status_id ? statusMap.get(row.status_id) ?? null : null;

    return serializeNotification(notifRow, {
      account: serializeAccount(accountRow),
      status: statusObj,
    });
  });

  if (pag.minId) notifications.reverse();

  const baseUrl = `https://${c.env.INSTANCE_DOMAIN}/api/v1/notifications`;
  const link = buildLinkHeader(baseUrl, notifications, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(notifications, 200, headers);
});

export default app;
