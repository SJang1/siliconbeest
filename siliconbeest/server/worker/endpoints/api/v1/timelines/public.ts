import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authOptional } from '../../../../middleware/auth';
import { parsePaginationParams, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount, serializeStatus } from '../../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import { getPublicTimeline } from '../../../../services/timeline';
import type { AccountRow, StatusRow } from '../../../../types/db';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authOptional, async (c) => {
  const local = c.req.query('local') === 'true';
  const remote = c.req.query('remote') === 'true';
  const onlyMedia = c.req.query('only_media') === 'true';

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const currentAccount = c.get('currentAccount');

  const allRows = await getPublicTimeline({
    maxId: pag.maxId,
    sinceId: pag.sinceId,
    minId: pag.minId,
    limit: pag.limit,
    local,
    remote,
    onlyMedia,
    viewerAccountId: currentAccount?.id,
  });

  const statusIds = allRows.map((r) => r.id as string);
  const currentAccountId = currentAccount?.id ?? null;

  // Collect reblog_of_ids
  const reblogOfIds = allRows
    .map((r) => r.reblog_of_id as string | null)
    .filter((id): id is string => !!id);
  const uniqueReblogIds = [...new Set(reblogOfIds)];

  // Enrich all statuses + reblog originals
  const allIdsToEnrich = [...statusIds, ...uniqueReblogIds];
  const enrichments = await enrichStatuses(env.INSTANCE_DOMAIN, allIdsToEnrich, currentAccountId, env.CACHE);

  // Fetch reblog originals
  const reblogMap = new Map<string, any>();
  if (uniqueReblogIds.length > 0) {
    const ph = uniqueReblogIds.map(() => '?').join(',');
    const { results: reblogResults } = await env.DB.prepare(
      `SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
              a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
              a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
              a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
              a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
              a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
              a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
              a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
              a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
           a.emoji_tags AS a_emoji_tags
       FROM statuses s JOIN accounts a ON a.id = s.account_id
       WHERE s.id IN (${ph}) AND s.deleted_at IS NULL`,
    ).bind(...uniqueReblogIds).all();

    for (const rr of (reblogResults ?? []) as Record<string, unknown>[]) {
      const origAccountRow: AccountRow = {
        id: rr.a_id as string, username: rr.a_username as string, domain: rr.a_domain as string | null,
        display_name: (rr.a_display_name as string) || '', note: (rr.a_note as string) || '',
        uri: rr.a_uri as string, url: (rr.a_url as string) || '',
        avatar_url: (rr.a_avatar_url as string) || '', avatar_static_url: (rr.a_avatar_static_url as string) || '',
        header_url: (rr.a_header_url as string) || '', header_static_url: (rr.a_header_static_url as string) || '',
        locked: rr.a_locked as number, bot: rr.a_bot as number, discoverable: rr.a_discoverable as number | null,
        manually_approves_followers: 0, statuses_count: (rr.a_statuses_count as number) || 0,
        followers_count: (rr.a_followers_count as number) || 0, following_count: (rr.a_following_count as number) || 0,
        last_status_at: rr.a_last_status_at as string | null, created_at: rr.a_created_at as string,
        updated_at: rr.a_created_at as string, suspended_at: rr.a_suspended_at as string | null,
        silenced_at: null, memorial: (rr.a_memorial as number) || 0, moved_to_account_id: rr.a_moved_to_account_id as string | null,
        emoji_tags: (rr.a_emoji_tags as string) || null,
      };
      const origE = enrichments.get(rr.id as string);
      reblogMap.set(rr.id as string, serializeStatus(rr as StatusRow, {
        account: serializeAccount(origAccountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
        mediaAttachments: origE?.mediaAttachments,
        mentions: origE?.mentions,
        favourited: origE?.favourited,
        reblogged: origE?.reblogged,
        bookmarked: origE?.bookmarked,
        card: origE?.card, poll: origE?.poll,
        emojis: origE?.emojis,
      }));
    }
  }

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
    const s = serializeStatus(row as StatusRow, {
      account: serializeAccount(accountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
      mediaAttachments: e?.mediaAttachments,
      mentions: e?.mentions,
      favourited: e?.favourited,
      reblogged: e?.reblogged,
      bookmarked: e?.bookmarked,
      card: e?.card, poll: e?.poll,
      emojis: e?.emojis,
    });
    if (row.reblog_of_id) {
      s.reblog = reblogMap.get(row.reblog_of_id) ?? null;
    }
    return s;
  });

  if (pag.minId) statuses.reverse();

  const baseUrl = `https://${env.INSTANCE_DOMAIN}/api/v1/timelines/public`;
  const link = buildLinkHeader(baseUrl, statuses, pag.limit);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(statuses, 200, headers);
});

export default app;
