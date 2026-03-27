import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { serializeAccount, serializeNotification, ensureISO8601 } from '../../../../utils/mastodonSerializer';
import type { AccountRow, NotificationRow } from '../../../../types/db';
import { enrichStatuses } from '../../../../utils/statusEnrichment';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:id', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;
  const id = c.req.param('id');

  const row: any = await c.env.DB.prepare(`
    SELECT n.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
           a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
           a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
           a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
           a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
           a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
           a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
           a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
           a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
           a.emoji_tags AS a_emoji_tags
    FROM notifications n
    JOIN accounts a ON a.id = n.from_account_id
    WHERE n.id = ?1 AND n.account_id = ?2
    LIMIT 1
  `).bind(id, account.id).first();

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

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
    emoji_tags: (row.a_emoji_tags as string) || null,
  };
  const notifRow: NotificationRow = {
    id: row.id, account_id: row.account_id, from_account_id: row.from_account_id,
    type: row.type, status_id: row.status_id, emoji: row.emoji ?? null, read: row.read, created_at: row.created_at,
  };

  // Fetch status if notification has one
  let statusObj: any = null;
  if (row.status_id) {
    const sr: any = await c.env.DB.prepare(
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
              sa.created_at AS sa_created_at, sa.emoji_tags AS sa_emoji_tags
       FROM statuses s
       JOIN accounts sa ON sa.id = s.account_id
       WHERE s.id = ?1 AND s.deleted_at IS NULL`,
    ).bind(row.status_id).first();

    if (sr) {
      const enrichments = await enrichStatuses(c.env.DB, domain, [sr.id], account.id, c.env.CACHE);
      const e = enrichments.get(sr.id);
      const saAcct = sr.sa_domain
        ? `${sr.sa_username}@${sr.sa_domain}`
        : sr.sa_username;

      const statusAccountRow: AccountRow = {
        id: sr.sa_id as string, username: sr.sa_username as string, domain: sr.sa_domain as string | null,
        display_name: (sr.sa_display_name as string) || '', note: (sr.sa_note as string) || '',
        uri: sr.sa_uri as string, url: (sr.sa_url as string) || '',
        avatar_url: (sr.sa_avatar_url as string) || '', avatar_static_url: (sr.sa_avatar_static_url as string) || '',
        header_url: (sr.sa_header_url as string) || '', header_static_url: (sr.sa_header_static_url as string) || '',
        locked: sr.sa_locked as number, bot: sr.sa_bot as number, discoverable: sr.sa_discoverable as number | null,
        manually_approves_followers: 0, statuses_count: (sr.sa_statuses_count || 0) as number,
        followers_count: (sr.sa_followers_count || 0) as number, following_count: (sr.sa_following_count || 0) as number,
        last_status_at: sr.sa_last_status_at as string | null, created_at: sr.sa_created_at as string,
        updated_at: sr.sa_created_at as string, suspended_at: null, silenced_at: null, memorial: 0, moved_to_account_id: null,
        emoji_tags: (sr.sa_emoji_tags as string) || null,
      };

      statusObj = {
        id: sr.id as string,
        uri: sr.uri,
        url: sr.url || null,
        created_at: ensureISO8601(sr.created_at as string),
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
        emojis: e?.emojis ?? [],
        account: serializeAccount(statusAccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
      };
    }
  }

  const notif = serializeNotification(notifRow, {
    account: serializeAccount(accountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
    status: statusObj,
  });
  // Attach custom emoji URL for emoji_reaction notifications
  if (notifRow.type === 'emoji_reaction' && notifRow.emoji?.startsWith(':') && notifRow.emoji?.endsWith(':')) {
    const sc = notifRow.emoji.slice(1, -1);
    const er = await c.env.DB.prepare(
      'SELECT domain, image_key FROM custom_emojis WHERE shortcode = ?1 LIMIT 1',
    ).bind(sc).first<{ domain: string | null; image_key: string }>();
    if (er) {
      const isLocal = !er.domain || er.domain === c.env.INSTANCE_DOMAIN;
      (notif as any).emoji_url = isLocal
        ? `https://${c.env.INSTANCE_DOMAIN}/media/${er.image_key}`
        : `https://${c.env.INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(er.image_key)}`;
    }
  }
  return c.json(notif);
});

export default app;
