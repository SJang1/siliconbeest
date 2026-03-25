import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { buildCreateActivity } from '../../../../federation/activityBuilder';
import { enqueueFanout, enqueueDelivery } from '../../../../federation/deliveryManager';
import { serializeNote } from '../../../../federation/noteSerializer';
import { parseContent, type ParsedMention } from '../../../../utils/contentParser';
import { resolveWebFinger } from '../../../../federation/webfinger';
import { resolveRemoteAccount } from '../../../../federation/resolveRemoteAccount';
import type { StatusRow, AccountRow } from '../../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}


const app = new Hono<HonoEnv>();

app.post('/', authRequired, async (c) => {
  const currentUser = c.get('currentUser')!;
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  let body: {
    status?: string;
    media_ids?: string[];
    poll?: { options: string[]; expires_in: number; multiple?: boolean };
    in_reply_to_id?: string;
    sensitive?: boolean;
    spoiler_text?: string;
    visibility?: string;
    language?: string;
    /** FEP-e232: ID of the status to quote */
    quote_id?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const statusText = (body.status || '').trim();
  const mediaIds = body.media_ids || [];

  if (!statusText && mediaIds.length === 0) {
    throw new AppError(422, 'Validation failed', 'Status text or media is required');
  }

  const now = new Date().toISOString();
  const statusId = generateULID();
  const visibility = body.visibility || 'public';
  const sensitive = body.sensitive ? 1 : 0;
  const spoilerText = body.spoiler_text || '';
  const language = body.language || 'en';
  const parsed = parseContent(statusText, domain);
  const content = parsed.html;
  const statusUri = `https://${domain}/users/${currentAccount.username}/statuses/${statusId}`;
  const statusUrl = `https://${domain}/@${currentAccount.username}/${statusId}`;

  let inReplyToId: string | null = null;
  let inReplyToAccountId: string | null = null;
  let conversationId: string | null = null;
  let isReply = 0;

  if (body.in_reply_to_id) {
    const parent = await c.env.DB.prepare(
      'SELECT id, account_id, conversation_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
    ).bind(body.in_reply_to_id).first();
    if (parent) {
      inReplyToId = parent.id as string;
      inReplyToAccountId = parent.account_id as string;
      conversationId = (parent.conversation_id as string) || null;
      isReply = 1;
    }
  }

  // FEP-e232: Resolve quote post
  let quoteId: string | null = null;
  let quoteUri: string | null = null;
  if (body.quote_id) {
    const quoted = await c.env.DB.prepare(
      'SELECT id, uri FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
    ).bind(body.quote_id).first();
    if (quoted) {
      quoteId = quoted.id as string;
      quoteUri = quoted.uri as string;
    }
  }

  let conversationApUri: string | null = null;
  if (!conversationId) {
    conversationId = generateULID();
    const year = now.substring(0, 4);
    conversationApUri = `tag:${domain},${year}:objectId=${conversationId}:objectType=Conversation`;
    await c.env.DB.prepare(
      'INSERT INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(conversationId, conversationApUri, now).run();
  } else {
    // Inherited conversation — look up its ap_uri
    const convRow = await c.env.DB.prepare(
      'SELECT ap_uri FROM conversations WHERE id = ?1',
    ).bind(conversationId).first<{ ap_uri: string | null }>();
    conversationApUri = convRow?.ap_uri ?? null;
  }

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id, text, content, content_warning, visibility, sensitive, language, conversation_id, reply, quote_id, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?16)`,
    ).bind(
      statusId, statusUri, statusUrl, currentUser.account_id,
      inReplyToId, inReplyToAccountId,
      statusText, content, spoilerText, visibility, sensitive, language,
      conversationId, isReply, quoteId, now,
    ),
    c.env.DB.prepare(
      'UPDATE accounts SET statuses_count = statuses_count + 1, last_status_at = ?1 WHERE id = ?2',
    ).bind(now, currentUser.account_id),
  ];

  // Update parent reply count
  if (inReplyToId) {
    stmts.push(
      c.env.DB.prepare('UPDATE statuses SET replies_count = replies_count + 1 WHERE id = ?1').bind(inReplyToId),
    );
  }

  // Link media attachments
  for (const mediaId of mediaIds) {
    stmts.push(
      c.env.DB.prepare('UPDATE media_attachments SET status_id = ?1 WHERE id = ?2 AND account_id = ?3')
        .bind(statusId, mediaId, currentUser.account_id),
    );
  }

  // Also insert into author's own home timeline
  stmts.push(
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(generateULID(), currentUser.account_id, statusId, now),
  );

  await c.env.DB.batch(stmts);

  // Enqueue timeline fanout to followers + federation delivery
  try {
    await c.env.QUEUE_INTERNAL.send({
      type: 'timeline_fanout',
      statusId,
      accountId: currentUser.account_id,
    });
  } catch {
    // Queue failure should not block status creation
  }

  // Enqueue preview card fetch for the first URL in the status text
  try {
    const urlMatch = statusText.match(/https?:\/\/[^\s<>"')\]]+/i);
    if (urlMatch) {
      await c.env.QUEUE_INTERNAL.send({
        type: 'fetch_preview_card',
        statusId,
        url: urlMatch[0],
      });
    }
  } catch {
    // Queue failure should not block status creation
  }

  // ============================================================
  // Handle hashtags (from parseContent results)
  // ============================================================
  const hashtags = parsed.tags;
  for (const tag of hashtags) {
    const existingTag = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ?1').bind(tag).first();
    let tagId: string;
    if (existingTag) {
      tagId = existingTag.id as string;
      await c.env.DB.prepare('UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, tagId).run();
    } else {
      tagId = generateULID();
      await c.env.DB.prepare(
        'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      ).bind(tagId, tag, tag, now).run();
    }
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES (?1, ?2)',
    ).bind(statusId, tagId).run();
  }

  // ============================================================
  // Handle mentions: resolve accounts (local + remote via WebFinger),
  // create DB mention rows, and send notifications BEFORE building
  // the AP note so serializeNote sees the correct mention data.
  // ============================================================
  interface ResolvedMention {
    account_id: string;
    actor_uri: string;
    acct: string;
    inbox_url: string | null;
    mentionDomain: string | null;
  }

  const resolvedMentions: ResolvedMention[] = [];

  for (const mention of parsed.mentions) {
    let accountRow: Record<string, unknown> | null = null;

    if (mention.domain) {
      // Federated mention: @user@domain  --  look up by username+domain
      accountRow = await c.env.DB.prepare(
        'SELECT id, uri, inbox_url, domain FROM accounts WHERE username = ?1 AND domain = ?2 LIMIT 1',
      ).bind(mention.username, mention.domain).first();

      // If not found locally, try WebFinger resolution
      if (!accountRow) {
        try {
          const wfResult = await resolveWebFinger(`${mention.username}@${mention.domain}`, c.env.CACHE);
          if (wfResult) {
            // resolveRemoteAccount will fetch the actor doc and upsert
            const accountId = await resolveRemoteAccount(wfResult.actorUri, c.env);
            if (accountId) {
              accountRow = await c.env.DB.prepare(
                'SELECT id, uri, inbox_url, domain FROM accounts WHERE id = ?1',
              ).bind(accountId).first();
            }
          }
        } catch (e) {
          console.error(`WebFinger resolution failed for ${mention.acct}:`, e);
        }
      }
    } else {
      // Local mention: @user
      accountRow = await c.env.DB.prepare(
        'SELECT id, uri, inbox_url, domain FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1',
      ).bind(mention.username).first();
    }

    if (!accountRow) continue;

    const mentionedAccountId = accountRow.id as string;
    const mentionId = generateULID();

    // Insert mention record into DB
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO mentions (id, status_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(mentionId, statusId, mentionedAccountId, now).run();

    resolvedMentions.push({
      account_id: mentionedAccountId,
      actor_uri: (accountRow.uri as string) || '',
      acct: mention.acct,
      inbox_url: (accountRow.inbox_url as string) || null,
      mentionDomain: (accountRow.domain as string) || null,
    });

    // Create mention notification (don't notify yourself)
    if (mentionedAccountId !== currentUser.account_id) {
      try {
        await c.env.QUEUE_INTERNAL.send({
          type: 'create_notification',
          recipientAccountId: mentionedAccountId,
          senderAccountId: currentUser.account_id,
          notificationType: 'mention',
          statusId,
        });
      } catch (_) { /* don't fail */ }
    }
  }

  // ============================================================
  // Fix content HTML: replace local proxy mention hrefs with actual actor URIs
  // This ensures AP Note content has correct links for remote servers
  // ============================================================
  let fixedContent = content;
  for (const rm of resolvedMentions) {
    if (rm.mentionDomain && rm.actor_uri) {
      // Get the actor's profile URL (actor_uri is like https://kokonect.link/users/SJang)
      const actorUrl = rm.actor_uri.replace('/users/', '/@').replace('/user/', '/@');
      const localProxyUrl = `https://${domain}/@${rm.acct}`;
      // Replace both the href and keep the display the same
      fixedContent = fixedContent.replace(
        `href="${localProxyUrl}"`,
        `href="${actorUrl}"`,
      );
    }
  }
  // Update DB content if changed
  if (fixedContent !== content) {
    await c.env.DB.prepare('UPDATE statuses SET content = ?1 WHERE id = ?2').bind(fixedContent, statusId).run();
  }

  // ============================================================
  // Federation: deliver Create(Note) activity
  // ============================================================
  try {
    const actorUri = `https://${domain}/users/${currentAccount.username}`;
    const fullAccount = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(currentAccount.id).first();
    const statusRowForNote: StatusRow = {
      id: statusId,
      uri: statusUri,
      url: statusUrl,
      account_id: currentUser.account_id,
      in_reply_to_id: inReplyToId,
      in_reply_to_account_id: inReplyToAccountId,
      reblog_of_id: null,
      text: statusText,
      content: fixedContent,
      content_warning: spoilerText,
      visibility,
      sensitive: sensitive,
      language,
      conversation_id: conversationId,
      reply: isReply,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      local: 1,
      federated_at: null,
      edited_at: null,
      deleted_at: null,
      poll_id: null,
      quote_id: quoteId,
      emoji_tags: null,
      created_at: now,
      updated_at: now,
    };
    const accountRowForNote: AccountRow = {
      id: currentUser.account_id,
      username: currentAccount.username,
      domain: null,
      display_name: (fullAccount?.display_name as string) || '',
      note: (fullAccount?.note as string) || '',
      uri: actorUri,
      url: `https://${domain}/@${currentAccount.username}`,
      avatar_url: (fullAccount?.avatar_url as string) || '',
      avatar_static_url: (fullAccount?.avatar_static_url as string) || '',
      header_url: (fullAccount?.header_url as string) || '',
      header_static_url: (fullAccount?.header_static_url as string) || '',
      locked: 0,
      bot: 0,
      discoverable: 1,
      manually_approves_followers: 0,
      statuses_count: 0,
      followers_count: 0,
      following_count: 0,
      last_status_at: null,
      created_at: now,
      updated_at: now,
      suspended_at: null,
      silenced_at: null,
      memorial: 0,
      moved_to_account_id: null,
    };

    // Build mention data for serializeNote (already resolved above)
    const mentionsForNote = resolvedMentions.map((rm) => ({
      account_id: rm.account_id,
      actor_uri: rm.actor_uri,
      acct: rm.acct,
      status_id: statusId,
      id: '',
      created_at: now,
      silent: 0,
    }));

    // Fetch media attachments for AP Note
    const { results: apMediaRows } = await c.env.DB.prepare(
      'SELECT * FROM media_attachments WHERE status_id = ?1',
    ).bind(statusId).all();
    const apAttachments = (apMediaRows ?? []).map((m: any) => ({
      url: `https://${domain}/media/${m.file_key}`,
      mediaType: m.file_content_type || 'image/jpeg',
      description: m.description || '',
      width: m.width as number | null,
      height: m.height as number | null,
      blurhash: m.blurhash as string | null,
      type: m.type || 'image',
    }));

    const note = serializeNote(statusRowForNote, accountRowForNote, domain, { mentions: mentionsForNote, conversationApUri, quoteUri, attachments: apAttachments });

    // Override inReplyTo with the parent status URI (not internal DB ID)
    if (inReplyToId) {
      const parentUri = await c.env.DB.prepare(
        'SELECT uri FROM statuses WHERE id = ?1',
      ).bind(inReplyToId).first<{ uri: string }>();
      if (parentUri) {
        note.inReplyTo = parentUri.uri;
      }
    }

    const activity = buildCreateActivity(actorUri, note);
    const activityJson = JSON.stringify(activity);

    // Collect remote inboxes we need to deliver to directly (mentioned users)
    const deliveredInboxes = new Set<string>();

    // Deliver to each mentioned remote user's inbox (for ALL visibility levels)
    for (const rm of resolvedMentions) {
      if (rm.mentionDomain && rm.inbox_url) {
        if (!deliveredInboxes.has(rm.inbox_url)) {
          deliveredInboxes.add(rm.inbox_url);
          await enqueueDelivery(c.env.QUEUE_FEDERATION, activityJson, rm.inbox_url, currentUser.account_id);
        }
      } else if (rm.mentionDomain && rm.actor_uri) {
        // Fallback: derive inbox from actor URI
        const fallbackInbox = `${rm.actor_uri}/inbox`;
        if (!deliveredInboxes.has(fallbackInbox)) {
          deliveredInboxes.add(fallbackInbox);
          await enqueueDelivery(c.env.QUEUE_FEDERATION, activityJson, fallbackInbox, currentUser.account_id);
        }
      }
    }

    if (visibility === 'public' || visibility === 'unlisted') {
      // Fanout to all followers
      await enqueueFanout(c.env.QUEUE_FEDERATION, activityJson, currentUser.account_id);

      // If this is a reply to a remote user, also deliver directly to their inbox
      if (inReplyToAccountId) {
        const parentAuthor = await c.env.DB.prepare(
          'SELECT id, domain, inbox_url, uri FROM accounts WHERE id = ?1',
        ).bind(inReplyToAccountId).first();
        if (parentAuthor && parentAuthor.domain) {
          const inbox = (parentAuthor.inbox_url as string) || `${parentAuthor.uri as string}/inbox`;
          if (!deliveredInboxes.has(inbox)) {
            await enqueueDelivery(c.env.QUEUE_FEDERATION, activityJson, inbox, currentUser.account_id);
          }
        }
      }
    }
  } catch (e) {
    console.error('Federation delivery failed for status create:', e);
  }

  // Fetch full account data for response
  const accountRow = await c.env.DB.prepare(
    'SELECT * FROM accounts WHERE id = ?1',
  ).bind(currentUser.account_id).first();

  const acct = accountRow!.username as string;
  const accountData = {
    id: accountRow!.id as string,
    username: accountRow!.username as string,
    acct,
    display_name: (accountRow!.display_name as string) || '',
    locked: !!(accountRow!.locked as number),
    bot: !!(accountRow!.bot as number),
    discoverable: accountRow!.discoverable == null ? null : !!(accountRow!.discoverable as number),
    group: false,
    created_at: accountRow!.created_at as string,
    note: (accountRow!.note as string) || '',
    url: (accountRow!.url as string) || `https://${domain}/@${acct}`,
    uri: (accountRow!.uri as string) || `https://${domain}/users/${acct}`,
    avatar: (accountRow!.avatar_url as string) || null,
    avatar_static: (accountRow!.avatar_static_url as string) || (accountRow!.avatar_url as string) || null,
    header: (accountRow!.header_url as string) || null,
    header_static: (accountRow!.header_static_url as string) || (accountRow!.header_url as string) || null,
    followers_count: (accountRow!.followers_count as number) || 0,
    following_count: (accountRow!.following_count as number) || 0,
    statuses_count: (accountRow!.statuses_count as number) || 0,
    last_status_at: (accountRow!.last_status_at as string) || null,
    emojis: [],
    fields: [],
  };

  // Fetch media attachments for response
  const { results: mediaResults } = await c.env.DB.prepare(
    'SELECT * FROM media_attachments WHERE status_id = ?1',
  ).bind(statusId).all();

  const mediaAttachments = (mediaResults as Record<string, unknown>[]).map((m) => ({
    id: m.id as string,
    type: (m.type as string) || 'image',
    url: `https://${domain}/media/${m.file_key}`,
    preview_url: m.thumbnail_key ? `https://${domain}/media/${m.thumbnail_key}` : `https://${domain}/media/${m.file_key}`,
    remote_url: (m.remote_url as string) || null,
    text_url: null,
    meta: null,
    description: (m.description as string) || null,
    blurhash: (m.blurhash as string) || null,
  }));

  // FEP-e232: Resolve quoted status for API response
  let quoteStatus: Record<string, unknown> | null = null;
  if (quoteId) {
    const quotedRow = await c.env.DB.prepare(
      `SELECT s.*, a.username AS account_username, a.domain AS account_domain,
        a.display_name AS account_display_name, a.note AS account_note,
        a.uri AS account_uri, a.url AS account_url,
        a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
        a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
        a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
        a.followers_count AS account_followers_count, a.following_count AS account_following_count,
        a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
        a.created_at AS account_created_at
      FROM statuses s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ?1 AND s.deleted_at IS NULL`,
    ).bind(quoteId).first();
    if (quotedRow) {
      const qAcct = quotedRow.account_domain
        ? `${quotedRow.account_username}@${quotedRow.account_domain}`
        : (quotedRow.account_username as string);
      quoteStatus = {
        id: quotedRow.id as string,
        created_at: quotedRow.created_at as string,
        in_reply_to_id: (quotedRow.in_reply_to_id as string) || null,
        in_reply_to_account_id: (quotedRow.in_reply_to_account_id as string) || null,
        sensitive: !!(quotedRow.sensitive),
        spoiler_text: (quotedRow.content_warning as string) || '',
        visibility: (quotedRow.visibility as string) || 'public',
        language: (quotedRow.language as string) || 'en',
        uri: quotedRow.uri as string,
        url: (quotedRow.url as string) || null,
        replies_count: (quotedRow.replies_count as number) || 0,
        reblogs_count: (quotedRow.reblogs_count as number) || 0,
        favourites_count: (quotedRow.favourites_count as number) || 0,
        favourited: false,
        reblogged: false,
        muted: false,
        bookmarked: false,
        pinned: false,
        content: (quotedRow.content as string) || '',
        reblog: null,
        quote: null,
        application: null,
        account: {
          id: quotedRow.account_id as string,
          username: quotedRow.account_username as string,
          acct: qAcct,
          display_name: (quotedRow.account_display_name as string) || '',
          locked: !!(quotedRow.account_locked),
          bot: !!(quotedRow.account_bot),
          discoverable: !!(quotedRow.account_discoverable),
          group: false,
          created_at: quotedRow.account_created_at as string,
          note: (quotedRow.account_note as string) || '',
          url: (quotedRow.account_url as string) || `https://${domain}/@${quotedRow.account_username}`,
          uri: quotedRow.account_uri as string,
          avatar: (quotedRow.account_avatar_url as string) || null,
          avatar_static: (quotedRow.account_avatar_static_url as string) || null,
          header: (quotedRow.account_header_url as string) || null,
          header_static: (quotedRow.account_header_static_url as string) || null,
          followers_count: (quotedRow.account_followers_count as number) || 0,
          following_count: (quotedRow.account_following_count as number) || 0,
          statuses_count: (quotedRow.account_statuses_count as number) || 0,
          last_status_at: (quotedRow.account_last_status_at as string) || null,
          emojis: [],
          fields: [],
        },
        media_attachments: [],
        mentions: [],
        tags: [],
        emojis: [],
        card: null,
        poll: null,
        edited_at: (quotedRow.edited_at as string) || null,
      };
    }
  }

  return c.json({
    id: statusId,
    created_at: now,
    in_reply_to_id: inReplyToId,
    in_reply_to_account_id: inReplyToAccountId,
    sensitive: !!sensitive,
    spoiler_text: spoilerText,
    visibility,
    language,
    uri: statusUri,
    url: statusUrl,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    content,
    reblog: null,
    quote: quoteStatus,
    application: null,
    account: accountData,
    media_attachments: mediaAttachments,
    mentions: resolvedMentions.map((rm) => ({
      id: rm.account_id,
      username: rm.acct.split('@')[0],
      url: rm.actor_uri,
      acct: rm.acct,
    })),
    tags: hashtags.map((t) => ({ name: t, url: `https://${domain}/tags/${t}` })),
    emojis: [],
    card: null,
    poll: null,
    edited_at: null,
  });
});

export default app;
