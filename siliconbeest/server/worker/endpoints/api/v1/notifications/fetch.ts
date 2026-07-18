import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { serializeAccount, serializeNotification, ensureISO8601 } from '../../../../utils/mastodonSerializer';
import type { AccountRow, NotificationRow } from '../../../../types/db';
import type { Status } from '../../../../types/mastodon';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import { getNotification } from '../../../../services/notification';
import { buildNotificationStatusSqlPredicate } from '../../../../services/permissions';

const app = new Hono<{ Variables: AppVariables }>();

function formatEmojiUrl(imageKey: string, emojiDomain: string | null, instanceDomain: string): string {
  if (!emojiDomain || emojiDomain === instanceDomain) {
    return imageKey.startsWith('http') ? imageKey : `https://${instanceDomain}/media/${imageKey}`;
  }
  const originalUrl = imageKey.startsWith('http') ? imageKey : `https://${emojiDomain}/${imageKey}`;
  return `https://${instanceDomain}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

app.get('/:id', authRequired, requireScope('read:notifications'), async (c) => {
  const account = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const id = c.req.param('id');

  const row = await getNotification(id, account.id);

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const accountRow: AccountRow = {
    id: row.a_id, username: row.a_username, domain: row.a_domain,
    display_name: row.a_display_name, note: row.a_note, uri: row.a_uri,
    url: row.a_url ?? '', avatar_url: row.a_avatar_url ?? '', avatar_static_url: row.a_avatar_static_url ?? '',
    header_url: row.a_header_url ?? '', header_static_url: row.a_header_static_url ?? '',
    locked: row.a_locked, bot: row.a_bot, discoverable: row.a_discoverable,
    manually_approves_followers: 0, statuses_count: row.a_statuses_count,
    followers_count: row.a_followers_count, following_count: row.a_following_count,
    last_status_at: row.a_last_status_at, created_at: row.a_created_at,
    updated_at: row.a_created_at, suspended_at: row.a_suspended_at,
    silenced_at: null, memorial: row.a_memorial, moved_to_account_id: row.a_moved_to_account_id,
    emoji_tags: row.a_emoji_tags || null,
  };
  const notifRow: NotificationRow = {
    id: row.id, account_id: row.account_id, from_account_id: row.from_account_id,
    type: row.type, status_id: row.status_id, emoji: row.emoji ?? null, read: row.read, created_at: row.created_at,
  };

  interface StatusWithAccountRow {
    id: string;
    uri: string;
    url: string | null;
    object_type: 'Note' | 'Article';
    title: string;
    poll_id: string | null;
    content: string;
    visibility: string;
    sensitive: number;
    content_warning: string;
    language: string | null;
    created_at: string;
    in_reply_to_id: string | null;
    in_reply_to_account_id: string | null;
    reblogs_count: number;
    favourites_count: number;
    replies_count: number;
    edited_at: string | null;
    quote_policy: string | null;
    sa_id: string;
    sa_username: string;
    sa_domain: string | null;
    sa_display_name: string;
    sa_note: string;
    sa_uri: string;
    sa_url: string | null;
    sa_avatar_url: string | null;
    sa_avatar_static_url: string | null;
    sa_header_url: string | null;
    sa_header_static_url: string | null;
    sa_locked: number;
    sa_bot: number;
    sa_discoverable: number | null;
    sa_followers_count: number;
    sa_following_count: number;
    sa_statuses_count: number;
    sa_last_status_at: string | null;
    sa_created_at: string;
    sa_emoji_tags: string | null;
  }

  // Fetch status if notification has one
  let statusObj: Status | null = null;
  if (row.status_id) {
    const statusPermission = buildNotificationStatusSqlPredicate(
      'status',
      account.id,
      new Date().toISOString(),
    );
    const sr = await env.DB.prepare(
      `SELECT s.id, s.uri, s.url, s.object_type, s.title, s.poll_id,
              s.content, s.visibility, s.sensitive,
              s.content_warning, s.language, s.created_at, s.in_reply_to_id,
              s.in_reply_to_account_id, s.reblogs_count, s.favourites_count,
              s.replies_count, s.edited_at, s.quote_policy,
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
       WHERE s.id = ?
         AND ${statusPermission.sql}`,
    ).bind(row.status_id, ...statusPermission.bindings).first<StatusWithAccountRow>();

    if (sr) {
      const enrichments = await enrichStatuses(domain, [sr.id], account.id, env.CACHE);
      const e = enrichments.get(sr.id);

      const statusAccountRow: AccountRow = {
        id: sr.sa_id, username: sr.sa_username, domain: sr.sa_domain,
        display_name: sr.sa_display_name || '', note: sr.sa_note || '',
        uri: sr.sa_uri, url: sr.sa_url || '',
        avatar_url: sr.sa_avatar_url || '', avatar_static_url: sr.sa_avatar_static_url || '',
        header_url: sr.sa_header_url || '', header_static_url: sr.sa_header_static_url || '',
        locked: sr.sa_locked, bot: sr.sa_bot, discoverable: sr.sa_discoverable,
        manually_approves_followers: 0, statuses_count: sr.sa_statuses_count || 0,
        followers_count: sr.sa_followers_count || 0, following_count: sr.sa_following_count || 0,
        last_status_at: sr.sa_last_status_at, created_at: sr.sa_created_at,
        updated_at: sr.sa_created_at, suspended_at: null, silenced_at: null, memorial: 0, moved_to_account_id: null,
        emoji_tags: sr.sa_emoji_tags || null,
      };

      statusObj = {
        id: sr.id,
        uri: sr.uri,
        url: sr.url || null,
        object_type: sr.poll_id ? 'Question' : sr.object_type,
        title: sr.title || '',
        created_at: ensureISO8601(sr.created_at),
        edited_at: sr.edited_at || null,
        content: sr.content || '',
        visibility: (sr.visibility || 'public') as Status['visibility'],
        sensitive: !!sr.sensitive,
        spoiler_text: sr.content_warning || '',
        language: sr.language || null,
        in_reply_to_id: sr.in_reply_to_id || null,
        in_reply_to_account_id: sr.in_reply_to_account_id || null,
        reblogs_count: sr.reblogs_count || 0,
        favourites_count: sr.favourites_count || 0,
        replies_count: sr.replies_count || 0,
        favourited: e?.favourited ?? false,
        reblogged: e?.reblogged ?? false,
        bookmarked: e?.bookmarked ?? false,
        muted: false,
        pinned: false,
        reblog: null,
        quote: e?.quote ?? null,
        quote_policy: sr.quote_policy === 'followers' || sr.quote_policy === 'nobody' ? sr.quote_policy : 'public',
        quote_policy_allows: e?.quotePolicyAllows ?? true,
        quote_policy_reason: e?.quotePolicyReason ?? null,
        poll: null,
        card: e?.card ?? null,
        application: null,
        text: null,
        filtered: [],
        media_attachments: e?.mediaAttachments ?? [],
        mentions: e?.mentions ?? [],
        tags: [],
        emojis: e?.emojis ?? [],
        account: serializeAccount(statusAccountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
      } as Status;
    }

    if (!statusObj) {
      return c.json({ error: 'Record not found' }, 404);
    }
  }

  const notif = serializeNotification(notifRow, {
    account: serializeAccount(accountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
    status: statusObj,
  });
  // Attach custom emoji URL for emoji_reaction notifications
  if (notifRow.type === 'emoji_reaction' && notifRow.emoji?.startsWith(':') && notifRow.emoji?.endsWith(':')) {
    const sc = notifRow.emoji.slice(1, -1);
    let er = row.status_id
      ? await env.DB.prepare(
        `SELECT ce.domain, ce.image_key
         FROM emoji_reactions er
         JOIN custom_emojis ce ON ce.id = er.custom_emoji_id
         WHERE er.status_id = ?1 AND er.account_id = ?2 AND er.emoji = ?3
         LIMIT 1`,
      ).bind(row.status_id, row.from_account_id, notifRow.emoji).first<{ domain: string | null; image_key: string }>()
      : null;
    er ??= await env.DB.prepare(
        'SELECT domain, image_key FROM custom_emojis WHERE shortcode = ?1 LIMIT 1',
      ).bind(sc).first<{ domain: string | null; image_key: string }>();
    if (er) {
      (notif as Record<string, unknown>).emoji_url = formatEmojiUrl(er.image_key, er.domain, env.INSTANCE_DOMAIN);
    }
  }
  return c.json(notif);
});

export default app;
