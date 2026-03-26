/**
 * Timeline Fanout Handler
 *
 * Loads all local followers of the account and batch-inserts
 * the status into their home_timeline_entries using D1 batch.
 */

import type { Env } from '../env';
import type { TimelineFanoutMessage } from '../shared/types/queue';

/** Read emoji_tags JSON from the status and return proxied emoji objects */
async function fetchEmojisForStatus(
  db: D1Database,
  statusId: string,
  instanceDomain: string,
): Promise<Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }>> {
  const row = await db.prepare(
    'SELECT emoji_tags, content, content_warning FROM statuses WHERE id = ?',
  ).bind(statusId).first();
  if (!row) return [];

  const tagsJson = row.emoji_tags as string | null;
  if (!tagsJson) return [];

  let tags: Array<{ shortcode?: string; name?: string; url?: string; icon?: { url?: string } }> = [];
  try { tags = JSON.parse(tagsJson); } catch { return []; }

  // Extract shortcodes actually used in content
  const text = ((row.content as string) || '') + ' ' + ((row.content_warning as string) || '');
  const shortcodesInContent = new Set<string>();
  const regex = /:([a-zA-Z0-9_]+):/g;
  let m;
  while ((m = regex.exec(text)) !== null) shortcodesInContent.add(m[1]);

  return tags
    .map((t) => {
      const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
      const url = t.url || t.icon?.url || '';
      if (!sc || !url || !shortcodesInContent.has(sc)) return null;
      const proxied = url.startsWith('http')
        ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(url)}`
        : url;
      return { shortcode: sc, url: proxied, static_url: proxied, visible_in_picker: false };
    })
    .filter(Boolean) as Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }>;
}

/** Fetch account emojis from the accounts.emoji_tags column */
async function fetchAccountEmojis(
  db: D1Database,
  accountId: string,
  instanceDomain: string,
): Promise<Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }>> {
  const row = await db.prepare(
    'SELECT emoji_tags FROM accounts WHERE id = ?',
  ).bind(accountId).first();
  if (!row) return [];

  const tagsJson = row.emoji_tags as string | null;
  if (!tagsJson) return [];

  let tags: Array<{ shortcode?: string; name?: string; url?: string; static_url?: string }> = [];
  try { tags = JSON.parse(tagsJson); } catch { return []; }

  return tags.map((t) => {
    const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
    const url = t.url || '';
    const staticUrl = t.static_url || url;
    const proxied = url.startsWith('http')
      ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(url)}`
      : url;
    const proxiedStatic = staticUrl.startsWith('http')
      ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(staticUrl)}`
      : staticUrl;
    return { shortcode: sc, url: proxied, static_url: proxiedStatic, visible_in_picker: false };
  }).filter((e) => e.shortcode && e.url);
}

export async function handleTimelineFanout(
  msg: TimelineFanoutMessage,
  env: Env,
): Promise<void> {
  const { statusId, accountId } = msg;

  // Skip DM fanout — DMs should not appear in followers' timelines
  const statusCheck = await env.DB.prepare(
    'SELECT visibility FROM statuses WHERE id = ? LIMIT 1',
  ).bind(statusId).first<{ visibility: string }>();
  if (statusCheck?.visibility === 'direct') {
    console.log(`Skipping timeline fanout for DM status ${statusId}`);
    return;
  }

  // Load all local followers of this account
  // Local accounts have domain IS NULL
  const rows = await env.DB.prepare(
    `SELECT f.account_id
     FROM follows f
     JOIN accounts a ON a.id = f.account_id
     WHERE f.target_account_id = ?
       AND a.domain IS NULL`,
  )
    .bind(accountId)
    .all<{ account_id: string }>();

  // Build list of local followers + always include the author
  const followerIds = (rows.results ?? []).map((r) => r.account_id);
  if (!followerIds.includes(accountId)) {
    followerIds.push(accountId);
  }

  if (followerIds.length === 0) {
    return;
  }

  // Batch insert into home_timeline_entries using D1 batch
  // D1 batch can handle many statements efficiently
  const BATCH_SIZE = 50;
  const statements: D1PreparedStatement[] = [];

  for (const followerId of followerIds) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO home_timeline_entries (account_id, status_id, created_at)
         VALUES (?, ?, datetime('now'))`,
      ).bind(followerId, statusId),
    );
  }

  // Execute in batches (D1 batch has limits)
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    await env.DB.batch(batch);
  }

  console.log(
    `Fanned out status ${statusId} to ${followerIds.length} local timelines`,
  );

  // Send streaming events to all local followers
  // Look up user IDs for all follower account IDs
  if (followerIds.length > 0) {
    const placeholders = followerIds.map(() => '?').join(',');
    const userRows = await env.DB.prepare(
      `SELECT id, account_id FROM users WHERE account_id IN (${placeholders})`,
    )
      .bind(...followerIds)
      .all<{ id: string; account_id: string }>();

    if (userRows.results && userRows.results.length > 0) {
      // Fetch the full status JSON to send as payload
      const statusRow = await env.DB.prepare(
        `SELECT s.id, s.uri, s.content, s.visibility, s.sensitive,
                s.content_warning, s.language, s.url, s.created_at,
                s.in_reply_to_id, s.in_reply_to_account_id, s.reblog_of_id,
                s.reblogs_count, s.favourites_count, s.replies_count,
                s.edited_at,
                a.id AS account_id, a.username, a.domain, a.display_name,
                a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
                a.avatar_url, a.header_url, a.locked, a.bot,
                a.followers_count, a.following_count, a.statuses_count,
                a.created_at AS account_created_at
         FROM statuses s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ?`,
      )
        .bind(statusId)
        .first();

      if (statusRow) {
        // Fetch custom emojis from emoji_tags JSON column
        const statusEmojis = await fetchEmojisForStatus(env.DB, statusId, env.INSTANCE_DOMAIN);

        // Account emojis from accounts.emoji_tags
        const accountEmojis = await fetchAccountEmojis(
          env.DB,
          statusRow.account_id as string,
          env.INSTANCE_DOMAIN,
        );

        // Fetch media attachments
        const { results: streamMediaRows } = await env.DB.prepare(
          'SELECT id, type, file_key, file_content_type, description, blurhash, width, height FROM media_attachments WHERE status_id = ?',
        ).bind(statusId).all();
        const streamMedia = (streamMediaRows ?? []).map((m: any) => {
          const fk = m.file_key as string;
          // file_key is a full URL for remote media, or a relative path for local
          const baseUrl = fk.startsWith('http') ? fk : `https://${env.INSTANCE_DOMAIN}/media/${fk}`;
          // Proxy remote URLs through our proxy endpoint
          const mediaUrl = fk.startsWith('http')
            ? `https://${env.INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(fk)}`
            : baseUrl;
          return {
          id: m.id, type: m.type || 'image',
          url: mediaUrl,
          preview_url: mediaUrl,
          remote_url: fk.startsWith('http') ? fk : null, text_url: null,
          meta: m.width ? { original: { width: m.width, height: m.height } } : null,
          description: m.description || null, blurhash: m.blurhash || null,
        };
        });

        let statusPayload = JSON.stringify({
          id: statusRow.id,
          uri: statusRow.uri,
          created_at: statusRow.created_at,
          content: statusRow.content,
          visibility: statusRow.visibility,
          sensitive: statusRow.sensitive === 1 || statusRow.sensitive === true,
          spoiler_text: statusRow.content_warning || '',
          language: statusRow.language,
          url: statusRow.url,
          in_reply_to_id: statusRow.in_reply_to_id,
          in_reply_to_account_id: statusRow.in_reply_to_account_id,
          reblogs_count: statusRow.reblogs_count || 0,
          favourites_count: statusRow.favourites_count || 0,
          replies_count: statusRow.replies_count || 0,
          edited_at: statusRow.edited_at,
          media_attachments: streamMedia,
          mentions: [],
          tags: [],
          emojis: statusEmojis,
          reblog: null as any,
          poll: null,
          card: null,
          application: null,
          text: null,
          filtered: [],
          account: {
            id: statusRow.account_id,
            username: statusRow.username,
            acct: statusRow.domain
              ? `${statusRow.username}@${statusRow.domain}`
              : statusRow.username,
            display_name: statusRow.display_name || '',
            locked: statusRow.locked === 1 || statusRow.locked === true,
            bot: statusRow.bot === 1 || statusRow.bot === true,
            discoverable: true,
            group: false,
            created_at: statusRow.account_created_at,
            note: statusRow.account_note || '',
            url: statusRow.account_url,
            uri: statusRow.account_uri,
            avatar: statusRow.avatar_url || '',
            avatar_static: statusRow.avatar_url || '',
            header: statusRow.header_url || '',
            header_static: statusRow.header_url || '',
            followers_count: statusRow.followers_count || 0,
            following_count: statusRow.following_count || 0,
            statuses_count: statusRow.statuses_count || 0,
            last_status_at: null,
            emojis: accountEmojis,
            fields: [],
          },
        });

        // If this is a reblog, fetch and attach the original status
        if (statusRow.reblog_of_id) {
          const origRow = await env.DB.prepare(
            `SELECT s.id, s.uri, s.content, s.visibility, s.sensitive,
                    s.content_warning, s.language, s.url, s.created_at,
                    s.in_reply_to_id, s.in_reply_to_account_id,
                    s.reblogs_count, s.favourites_count, s.replies_count, s.edited_at,
                    a.id AS account_id, a.username, a.domain, a.display_name,
                    a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
                    a.avatar_url, a.header_url, a.locked, a.bot,
                    a.followers_count, a.following_count, a.statuses_count,
                    a.created_at AS account_created_at
             FROM statuses s JOIN accounts a ON a.id = s.account_id
             WHERE s.id = ? AND s.deleted_at IS NULL`,
          ).bind(statusRow.reblog_of_id).first();

          if (origRow) {
            const origAcctEmojis = await fetchAccountEmojis(env.DB, origRow.account_id as string, env.INSTANCE_DOMAIN);
            const parsed = JSON.parse(statusPayload);
            parsed.reblog = {
              id: origRow.id, uri: origRow.uri, created_at: origRow.created_at,
              content: origRow.content, visibility: origRow.visibility,
              sensitive: origRow.sensitive === 1, spoiler_text: origRow.content_warning || '',
              language: origRow.language, url: origRow.url,
              in_reply_to_id: origRow.in_reply_to_id, in_reply_to_account_id: origRow.in_reply_to_account_id,
              reblogs_count: origRow.reblogs_count || 0, favourites_count: origRow.favourites_count || 0,
              replies_count: origRow.replies_count || 0, edited_at: origRow.edited_at,
              media_attachments: [], mentions: [], tags: [], emojis: [],
              reblog: null, poll: null, card: null, application: null, text: null, filtered: [],
              account: {
                id: origRow.account_id, username: origRow.username,
                acct: origRow.domain ? `${origRow.username}@${origRow.domain}` : origRow.username,
                display_name: origRow.display_name || '', locked: origRow.locked === 1,
                bot: origRow.bot === 1, discoverable: true, group: false,
                created_at: origRow.account_created_at, note: origRow.account_note || '',
                url: origRow.account_url, uri: origRow.account_uri,
                avatar: origRow.avatar_url || '', avatar_static: origRow.avatar_url || '',
                header: origRow.header_url || '', header_static: origRow.header_url || '',
                followers_count: origRow.followers_count || 0, following_count: origRow.following_count || 0,
                statuses_count: origRow.statuses_count || 0, last_status_at: null, emojis: origAcctEmojis, fields: [],
              },
            };
            statusPayload = JSON.stringify(parsed);
          }
        }

        // Send streaming event to each user via worker service binding
        const streamPromises = userRows.results.map((user) =>
          env.WORKER.fetch(
            new Request('http://internal/internal/stream-event', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: user.id,
                event: 'update',
                payload: statusPayload,
                stream: ['user'],
              }),
            }),
          ).catch((err) => {
            console.error(`Failed to send stream event to user ${user.id}:`, err);
          }),
        );

        await Promise.allSettled(streamPromises);

        console.log(
          `Sent streaming events for status ${statusId} to ${userRows.results.length} users`,
        );
      }
    }
  }

  // Broadcast to public/local streams — INDEPENDENT of follower count
  // Fetch status data for streaming payload if not already fetched above
  const publicStatusRow = await env.DB.prepare(
    `SELECT s.id, s.uri, s.content, s.visibility, s.sensitive,
            s.content_warning, s.language, s.url, s.created_at,
            s.in_reply_to_id, s.in_reply_to_account_id, s.reblog_of_id,
            s.reblogs_count, s.favourites_count, s.replies_count, s.edited_at,
            a.id AS account_id, a.username, a.domain, a.display_name,
            a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
            a.avatar_url, a.header_url, a.locked, a.bot,
            a.followers_count, a.following_count, a.statuses_count,
            a.created_at AS account_created_at
     FROM statuses s JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?`,
  ).bind(statusId).first();

  if (publicStatusRow && (publicStatusRow.visibility === 'public' || publicStatusRow.visibility === 'unlisted')) {
    const pubEmojis = await fetchEmojisForStatus(env.DB, statusId, env.INSTANCE_DOMAIN);
    // Account emojis from accounts.emoji_tags
    const pubAccountEmojis = await fetchAccountEmojis(
      env.DB,
      publicStatusRow.account_id as string,
      env.INSTANCE_DOMAIN,
    );
    // Fetch media for public streaming
    const { results: pubMediaRows } = await env.DB.prepare(
      'SELECT id, type, file_key, file_content_type, description, blurhash, width, height FROM media_attachments WHERE status_id = ?',
    ).bind(publicStatusRow.id).all();
    const pubMedia = (pubMediaRows ?? []).map((m: any) => {
      const pfk = m.file_key as string;
      const pubMediaUrl = pfk.startsWith('http')
        ? `https://${env.INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(pfk)}`
        : `https://${env.INSTANCE_DOMAIN}/media/${pfk}`;
      return {
      id: m.id, type: m.type || 'image',
      url: pubMediaUrl,
      preview_url: pubMediaUrl,
      remote_url: pfk.startsWith('http') ? pfk : null, text_url: null,
      meta: m.width ? { original: { width: m.width, height: m.height } } : null,
      description: m.description || null, blurhash: m.blurhash || null,
      };
    });
    let pubPayload = JSON.stringify({
      id: publicStatusRow.id, uri: publicStatusRow.uri, created_at: publicStatusRow.created_at,
      content: publicStatusRow.content, visibility: publicStatusRow.visibility,
      sensitive: publicStatusRow.sensitive === 1 || publicStatusRow.sensitive === true,
      spoiler_text: publicStatusRow.content_warning || '', language: publicStatusRow.language,
      url: publicStatusRow.url, in_reply_to_id: publicStatusRow.in_reply_to_id,
      in_reply_to_account_id: publicStatusRow.in_reply_to_account_id,
      reblogs_count: publicStatusRow.reblogs_count || 0,
      favourites_count: publicStatusRow.favourites_count || 0,
      replies_count: publicStatusRow.replies_count || 0, edited_at: publicStatusRow.edited_at,
      media_attachments: pubMedia, mentions: [], tags: [], emojis: pubEmojis,
      reblog: null as any, poll: null, card: null, application: null, text: null, filtered: [],
      account: {
        id: publicStatusRow.account_id, username: publicStatusRow.username,
        acct: publicStatusRow.domain ? `${publicStatusRow.username}@${publicStatusRow.domain}` : publicStatusRow.username,
        display_name: publicStatusRow.display_name || '',
        locked: publicStatusRow.locked === 1, bot: publicStatusRow.bot === 1,
        discoverable: true, group: false, created_at: publicStatusRow.account_created_at,
        note: publicStatusRow.account_note || '',
        url: publicStatusRow.account_url, uri: publicStatusRow.account_uri,
        avatar: publicStatusRow.avatar_url || '', avatar_static: publicStatusRow.avatar_url || '',
        header: publicStatusRow.header_url || '', header_static: publicStatusRow.header_url || '',
        followers_count: publicStatusRow.followers_count || 0,
        following_count: publicStatusRow.following_count || 0,
        statuses_count: publicStatusRow.statuses_count || 0,
        last_status_at: null, emojis: pubAccountEmojis, fields: [],
      },
    });

    // Resolve reblog if applicable
    if (publicStatusRow.reblog_of_id) {
      const origRow = await env.DB.prepare(
        `SELECT s.*, a.id AS account_id, a.username, a.domain, a.display_name,
                a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
                a.avatar_url, a.header_url, a.locked, a.bot,
                a.followers_count, a.following_count, a.statuses_count,
                a.created_at AS account_created_at
         FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ? AND s.deleted_at IS NULL`,
      ).bind(publicStatusRow.reblog_of_id).first();
      if (origRow) {
        const origAcctEmojis = await fetchAccountEmojis(env.DB, origRow.account_id as string, env.INSTANCE_DOMAIN);
        const parsed = JSON.parse(pubPayload);
        parsed.reblog = {
          id: origRow.id, uri: origRow.uri, created_at: origRow.created_at,
          content: origRow.content, visibility: origRow.visibility,
          sensitive: origRow.sensitive === 1, spoiler_text: (origRow as any).content_warning || '',
          language: origRow.language, url: origRow.url,
          in_reply_to_id: origRow.in_reply_to_id, in_reply_to_account_id: origRow.in_reply_to_account_id,
          reblogs_count: origRow.reblogs_count || 0, favourites_count: origRow.favourites_count || 0,
          replies_count: origRow.replies_count || 0, edited_at: origRow.edited_at,
          media_attachments: [], mentions: [], tags: [], emojis: [],
          reblog: null, poll: null, card: null, application: null, text: null, filtered: [],
          account: {
            id: origRow.account_id, username: origRow.username,
            acct: (origRow as any).domain ? `${origRow.username}@${(origRow as any).domain}` : origRow.username,
            display_name: (origRow as any).display_name || '', locked: origRow.locked === 1,
            bot: origRow.bot === 1, discoverable: true, group: false,
            created_at: (origRow as any).account_created_at, note: (origRow as any).account_note || '',
            url: (origRow as any).account_url, uri: (origRow as any).account_uri,
            avatar: (origRow as any).avatar_url || '', avatar_static: (origRow as any).avatar_url || '',
            header: (origRow as any).header_url || '', header_static: (origRow as any).header_url || '',
            followers_count: (origRow as any).followers_count || 0,
            following_count: (origRow as any).following_count || 0,
            statuses_count: (origRow as any).statuses_count || 0,
            last_status_at: null, emojis: origAcctEmojis, fields: [],
          },
        };
        pubPayload = JSON.stringify(parsed);
      }
    }

    const publicStreams = ['public'];
    if (!publicStatusRow.domain) publicStreams.push('public:local');

    console.log(`Broadcasting to public streams: ${publicStreams.join(', ')} for status ${statusId}`);
    await env.WORKER.fetch(
      new Request('http://internal/internal/stream-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: '__public__',
          event: 'update',
          payload: pubPayload,
          stream: publicStreams,
        }),
      }),
    ).catch((err) => {
      console.error(`Failed to broadcast to public streams:`, err);
    });
  }
}
