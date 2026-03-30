import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { parseContent, type ParsedMention } from '../../../../utils/contentParser';
import { resolveRemoteAccount } from '../../../../federation/resolveRemoteAccount';
import { getFedifyContext, sendToFollowers, sendToRecipient } from '../../../../federation/helpers/send';
import {
  Create,
  Note,
  Mention,
  Hashtag,
  Image,
  Document as APDocument,
  Source,
  Emoji as APEmoji,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import { generateUlid } from '../../../../utils/ulid';

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

  // Detect custom emojis in content text (both status text and CW)
  let emojiTagsJson: string | null = null;
  let resolvedEmojiTags: Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> = [];
  const emojiMatches = [...new Set(
    [...(statusText || '').matchAll(/:([a-zA-Z0-9_]+):/g),
     ...((spoilerText || '').matchAll(/:([a-zA-Z0-9_]+):/g))].map(m => m[1])
  )];
  if (emojiMatches.length > 0) {
    const placeholders = emojiMatches.map(() => '?').join(',');
    const emojiRows = await c.env.DB.prepare(
      `SELECT shortcode, domain, image_key FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = ?${emojiMatches.length + 1})`,
    ).bind(...emojiMatches, domain).all<{ shortcode: string; domain: string | null; image_key: string }>();
    if (emojiRows.results.length > 0) {
      resolvedEmojiTags = emojiRows.results.map(e => {
        const isLocal = !e.domain || e.domain === domain;
        const url = isLocal ? `https://${domain}/media/${e.image_key}` : e.image_key;
        return { shortcode: e.shortcode, url, static_url: url, visible_in_picker: false };
      });
      emojiTagsJson = JSON.stringify(resolvedEmojiTags.map(e => ({ shortcode: e.shortcode, url: e.url, static_url: e.static_url })));
    }
  }

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id, text, content, content_warning, visibility, sensitive, language, conversation_id, reply, quote_id, local, emoji_tags, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?17, ?17)`,
    ).bind(
      statusId, statusUri, statusUrl, currentUser.account_id,
      inReplyToId, inReplyToAccountId,
      statusText, content, spoilerText, visibility, sensitive, language,
      conversationId, isReply, quoteId, emojiTagsJson, now,
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

  // Enqueue timeline fanout to followers (skip for DMs — handled after mentions are resolved)
  if (visibility !== 'direct') {
    try {
      await c.env.QUEUE_INTERNAL.send({
        type: 'timeline_fanout',
        statusId,
        accountId: currentUser.account_id,
      });
    } catch {
      // Queue failure should not block status creation
    }
  }

  // DM timeline + streaming is handled after resolvedMentions below

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
  if (hashtags.length > 0) {
    // Batch SELECT all existing tags
    const existingTags = await c.env.DB.prepare(
      `SELECT id, name FROM tags WHERE name IN (${hashtags.map(() => '?').join(',')})`
    ).bind(...hashtags).all<{ id: string; name: string }>();

    const existingTagMap = new Map(existingTags.results.map(t => [t.name, t.id]));
    const newTagsToInsert: Array<{ id: string; name: string }> = [];
    const allTagIds: string[] = [];

    for (const tag of hashtags) {
      let tagId: string;
      if (existingTagMap.has(tag)) {
        tagId = existingTagMap.get(tag)!;
        // Queue update for existing tag
        await c.env.DB.prepare('UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, tagId).run();
      } else {
        tagId = generateULID();
        newTagsToInsert.push({ id: tagId, name: tag });
      }
      allTagIds.push(tagId);
    }

    // Batch INSERT all new tags at once
    if (newTagsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES ';
      newTagsToInsert.forEach((tag, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4}, ?${idx * 4 + 4})`;
        values.push(tag.id, tag.name, tag.name, now);
      });
      await c.env.DB.prepare(query).bind(...values).run();
    }

    // Batch INSERT all status_tags at once
    if (allTagIds.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES ';
      allTagIds.forEach((tagId, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 2 + 1}, ?${idx * 2 + 2})`;
        values.push(statusId, tagId);
      });
      await c.env.DB.prepare(query).bind(...values).run();
    }
  }

  // ============================================================
  // Handle mentions: resolve accounts (local + remote via WebFinger),
  // create DB mention rows, and send notifications BEFORE building
  // the AP note so serializeNote sees the correct mention data.
  // ============================================================
  interface ResolvedMention {
    account_id: string;
    actor_uri: string;
    profile_url: string | null;
    acct: string;
    inbox_url: string | null;
    mentionDomain: string | null;
  }

  const resolvedMentions: ResolvedMention[] = [];

  if (parsed.mentions.length > 0) {
    // Separate local and remote mentions
    const localMentions = parsed.mentions.filter(m => !m.domain);
    const remoteMentions = parsed.mentions.filter(m => m.domain);

    // Batch SELECT all local accounts at once
    const localAccountMap = new Map<string, Record<string, unknown>>();
    if (localMentions.length > 0) {
      const localUsernames = localMentions.map(m => m.username);
      const localAccounts = await c.env.DB.prepare(
        `SELECT id, uri, url, inbox_url, domain FROM accounts WHERE username IN (${localUsernames.map(() => '?').join(',')}) AND domain IS NULL`
      ).bind(...localUsernames).all<Record<string, unknown>>();
      localAccounts.results.forEach(acc => {
        localAccountMap.set(acc.username as string, acc);
      });
    }

    // Parallelize WebFinger lookups and resolve remote accounts
    const remoteMentionPromises = remoteMentions.map(async (mention) => {
      let accountRow: Record<string, unknown> | null = null;

      // Try local lookup first
      accountRow = await c.env.DB.prepare(
        'SELECT id, uri, url, inbox_url, domain FROM accounts WHERE username = ?1 AND domain = ?2 LIMIT 1',
      ).bind(mention.username, mention.domain).first();

      // If not found locally, try WebFinger resolution via Fedify
      if (!accountRow) {
        try {
          const fed = c.get('federation');
          const ctx = getFedifyContext(fed, c.env);
          const wfResult = await ctx.lookupWebFinger(`acct:${mention.username}@${mention.domain}`);
          if (wfResult) {
            // Extract actor URI from self link
            const selfLink = wfResult.links?.find(
              (link) =>
                link.rel === 'self' &&
                (link.type === 'application/activity+json' ||
                  link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
                link.href,
            );
            if (selfLink?.href) {
              // resolveRemoteAccount will fetch the actor doc and upsert
              const accountId = await resolveRemoteAccount(selfLink.href, c.env);
              if (accountId) {
                accountRow = await c.env.DB.prepare(
                  'SELECT id, uri, url, inbox_url, domain FROM accounts WHERE id = ?1',
                ).bind(accountId).first();
              }
            }
          }
        } catch (e) {
          console.error(`WebFinger resolution failed for ${mention.acct}:`, e);
        }
      }

      return { mention, accountRow };
    });

    const resolvedRemote = await Promise.all(remoteMentionPromises);

    // Prepare all mentions for batch operations
    const mentionsToInsert: Array<[string, string, string, string]> = []; // [mentionId, statusId, accountId, now]
    const notificationsToQueue: Array<{ recipientAccountId: string; mention: string }> = [];

    // Process local mentions
    for (const mention of localMentions) {
      const accountRow = localAccountMap.get(mention.username);
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
      const mentionId = generateULID();

      mentionsToInsert.push([mentionId, statusId, mentionedAccountId, now]);

      resolvedMentions.push({
        account_id: mentionedAccountId,
        actor_uri: (accountRow.uri as string) || '',
        profile_url: (accountRow.url as string) || null,
        acct: mention.acct,
        inbox_url: (accountRow.inbox_url as string) || null,
        mentionDomain: (accountRow.domain as string) || null,
      });

      if (mentionedAccountId !== currentUser.account_id) {
        notificationsToQueue.push({ recipientAccountId: mentionedAccountId, mention: 'mention' });
      }
    }

    // Process remote mentions
    for (const { mention, accountRow } of resolvedRemote) {
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
      const mentionId = generateULID();

      mentionsToInsert.push([mentionId, statusId, mentionedAccountId, now]);

      resolvedMentions.push({
        account_id: mentionedAccountId,
        actor_uri: (accountRow.uri as string) || '',
        profile_url: (accountRow.url as string) || null,
        acct: mention.acct,
        inbox_url: (accountRow.inbox_url as string) || null,
        mentionDomain: (accountRow.domain as string) || null,
      });

      if (mentionedAccountId !== currentUser.account_id) {
        notificationsToQueue.push({ recipientAccountId: mentionedAccountId, mention: 'mention' });
      }
    }

    // Batch INSERT all mentions at once
    if (mentionsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO mentions (id, status_id, account_id, created_at) VALUES ';
      mentionsToInsert.forEach((mention, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4})`;
        values.push(...mention);
      });
      await c.env.DB.prepare(query).bind(...values).run();
    }

    // Batch queue all notifications (fire and forget, don't block)
    for (const notification of notificationsToQueue) {
      try {
        await c.env.QUEUE_INTERNAL.send({
          type: 'create_notification',
          recipientAccountId: notification.recipientAccountId,
          senderAccountId: currentUser.account_id,
          notificationType: notification.mention,
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
      // Use the profile URL from DB (correct for all server types including Misskey)
      // Fallback to actor_uri only if profile_url is missing
      const profileUrl = rm.profile_url || rm.actor_uri;
      const localProxyUrl = `https://${domain}/@${rm.acct}`;
      fixedContent = fixedContent.replace(
        `href="${localProxyUrl}"`,
        `href="${profileUrl}"`,
      );
    }
  }
  // Update DB content if changed
  if (fixedContent !== content) {
    await c.env.DB.prepare('UPDATE statuses SET content = ?1 WHERE id = ?2').bind(fixedContent, statusId).run();
  }

  // ============================================================
  // DM: timeline insert + streaming for author + mentioned LOCAL users
  // ============================================================
  if (visibility === 'direct') {
    try {
      const dmTimelineStmts = [
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO home_timeline_entries (status_id, account_id, created_at) VALUES (?1, ?2, ?3)',
        ).bind(statusId, currentUser.account_id, now),
      ];
      for (const rm of resolvedMentions) {
        if (!rm.mentionDomain) {
          dmTimelineStmts.push(
            c.env.DB.prepare(
              'INSERT OR IGNORE INTO home_timeline_entries (status_id, account_id, created_at) VALUES (?1, ?2, ?3)',
            ).bind(statusId, rm.account_id, now),
          );
        }
      }
      await c.env.DB.batch(dmTimelineStmts);

      // Streaming: fetch full status from DB for accurate payload
      const { sendStreamEvent } = await import('../../../../services/streaming');
      const dmRow = await c.env.DB.prepare(
        `SELECT s.*, a.username AS a_username, a.domain AS a_domain, a.display_name AS a_display_name,
                a.note AS a_note, a.uri AS a_uri, a.url AS a_url, a.avatar_url AS a_avatar_url,
                a.avatar_static_url AS a_avatar_static_url, a.header_url AS a_header_url,
                a.header_static_url AS a_header_static_url, a.locked AS a_locked, a.bot AS a_bot,
                a.discoverable AS a_discoverable, a.followers_count AS a_followers_count,
                a.following_count AS a_following_count, a.statuses_count AS a_statuses_count,
                a.last_status_at AS a_last_status_at, a.created_at AS a_created_at
         FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?1`,
      ).bind(statusId).first();

      if (dmRow) {
        const { results: dmMedia } = await c.env.DB.prepare(
          'SELECT id, type, file_key, description, blurhash, width, height FROM media_attachments WHERE status_id = ?1',
        ).bind(statusId).all();
        const mediaArr = (dmMedia ?? []).map((m: any) => {
          const fk = m.file_key as string;
          const mUrl = fk.startsWith('http') ? `https://${domain}/proxy?url=${encodeURIComponent(fk)}` : `https://${domain}/media/${fk}`;
          return { id: m.id, type: m.type || 'image', url: mUrl, preview_url: mUrl, remote_url: fk.startsWith('http') ? fk : null, text_url: null, meta: m.width ? { original: { width: m.width, height: m.height } } : null, description: m.description || null, blurhash: m.blurhash || null };
        });
        const dmAcct = (dmRow as any).a_domain ? `${(dmRow as any).a_username}@${(dmRow as any).a_domain}` : (dmRow as any).a_username;
        const dmPayload = JSON.stringify({
          id: statusId, uri: statusUri, created_at: now, content: fixedContent, visibility,
          sensitive: !!sensitive, spoiler_text: spoilerText, language, url: statusUrl,
          in_reply_to_id: inReplyToId, in_reply_to_account_id: inReplyToAccountId,
          reblogs_count: (dmRow as any).reblogs_count || 0, favourites_count: (dmRow as any).favourites_count || 0,
          replies_count: (dmRow as any).replies_count || 0, edited_at: (dmRow as any).edited_at || null,
          media_attachments: mediaArr, mentions: resolvedMentions.map((rm) => ({ id: rm.account_id, username: rm.acct.split('@')[0], url: rm.actor_uri, acct: rm.acct })),
          tags: parsed.tags.map((t) => ({ name: t, url: `https://${domain}/tags/${t}` })),
          emojis: [], reblog: null, poll: null, card: null, application: null, text: null, filtered: [],
          account: {
            id: currentUser.account_id, username: (dmRow as any).a_username, acct: dmAcct,
            display_name: (dmRow as any).a_display_name || '', locked: !!((dmRow as any).a_locked),
            bot: !!((dmRow as any).a_bot), discoverable: !!((dmRow as any).a_discoverable), group: false,
            created_at: (dmRow as any).a_created_at || now, note: (dmRow as any).a_note || '',
            url: (dmRow as any).a_url || `https://${domain}/@${currentAccount.username}`,
            uri: (dmRow as any).a_uri || `https://${domain}/users/${currentAccount.username}`,
            avatar: (dmRow as any).a_avatar_url || '', avatar_static: (dmRow as any).a_avatar_static_url || (dmRow as any).a_avatar_url || '',
            header: (dmRow as any).a_header_url || '', header_static: (dmRow as any).a_header_static_url || (dmRow as any).a_header_url || '',
            followers_count: (dmRow as any).a_followers_count || 0, following_count: (dmRow as any).a_following_count || 0,
            statuses_count: (dmRow as any).a_statuses_count || 0, last_status_at: (dmRow as any).a_last_status_at || null,
            emojis: [], fields: [],
          },
        });

        // Stream to author
        try { await sendStreamEvent(c.env.STREAMING_DO, currentUser.id, { event: 'update', payload: dmPayload, stream: ['user', 'direct'] }); } catch {}
        // Stream to mentioned local users
        for (const rm of resolvedMentions) {
          if (!rm.mentionDomain) {
            const mUser = await c.env.DB.prepare('SELECT id FROM users WHERE account_id = ?1 LIMIT 1').bind(rm.account_id).first();
            if (mUser) { try { await sendStreamEvent(c.env.STREAMING_DO, mUser.id as string, { event: 'update', payload: dmPayload, stream: ['user', 'direct'] }); } catch {} }
          }
        }
      }
    } catch { /* DM timeline/streaming failure should not block */ }
  }

  // ============================================================
  // Federation: deliver Create(Note) activity via Fedify
  // ============================================================
  try {
    const actorUri = `https://${domain}/users/${currentAccount.username}`;
    const followersUri = `${actorUri}/followers`;

    // -- Addressing: to/cc based on visibility --
    const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
    const mentionUris = resolvedMentions
      .filter((rm) => rm.actor_uri)
      .map((rm) => new URL(rm.actor_uri));

    let toUrls: URL[];
    let ccUrls: URL[];
    switch (visibility) {
      case 'public':
        toUrls = [new URL(AS_PUBLIC)];
        ccUrls = [new URL(followersUri), ...mentionUris];
        break;
      case 'unlisted':
        toUrls = [new URL(followersUri)];
        ccUrls = [new URL(AS_PUBLIC), ...mentionUris];
        break;
      case 'private':
        toUrls = [new URL(followersUri)];
        ccUrls = [...mentionUris];
        break;
      case 'direct':
        toUrls = [...mentionUris];
        ccUrls = [];
        break;
      default:
        toUrls = [new URL(AS_PUBLIC)];
        ccUrls = [new URL(followersUri), ...mentionUris];
    }

    // -- Resolve inReplyTo URI --
    let replyTarget: URL | undefined;
    if (inReplyToId) {
      const parentUri = await c.env.DB.prepare(
        'SELECT uri FROM statuses WHERE id = ?1',
      ).bind(inReplyToId).first<{ uri: string }>();
      if (parentUri) {
        replyTarget = new URL(parentUri.uri);
      }
    }

    // -- Build Mention tags --
    const mentionTags = resolvedMentions.map((rm) =>
      new Mention({
        href: rm.actor_uri ? new URL(rm.actor_uri) : undefined,
        name: `@${rm.acct}`,
      }),
    );

    // -- Build Hashtag tags --
    const hashtagTags = hashtags.map((tag) =>
      new Hashtag({
        href: new URL(`https://${domain}/tags/${tag}`),
        name: `#${tag}`,
      }),
    );

    // -- Build media attachments --
    const { results: apMediaRows } = await c.env.DB.prepare(
      'SELECT * FROM media_attachments WHERE status_id = ?1',
    ).bind(statusId).all();
    const mediaAttachmentObjects = (apMediaRows ?? []).map((m: any) => {
      const attUrl = new URL(`https://${domain}/media/${m.file_key}`);
      const attMediaType = m.file_content_type || 'image/jpeg';
      const attName = m.description || null;
      if ((m.type || 'image') === 'image') {
        return new Image({
          url: attUrl,
          mediaType: attMediaType,
          name: attName,
        });
      }
      return new APDocument({
        url: attUrl,
        mediaType: attMediaType,
        name: attName,
      });
    });

    // -- Build Fedify Note --
    const noteValues: ConstructorParameters<typeof Note>[0] = {
      id: new URL(statusUri),
      attribution: new URL(actorUri),
      content: fixedContent,
      url: new URL(statusUrl),
      published: Temporal.Instant.from(now),
      tos: toUrls,
      ccs: ccUrls,
      sensitive: !!sensitive,
      summary: spoilerText || null,
    };

    if (replyTarget) {
      noteValues.replyTarget = replyTarget;
    }

    // Build custom emoji tags for federation
    const emojiTagObjects: APEmoji[] = [];
    if (emojiTagsJson) {
      try {
        const parsed = JSON.parse(emojiTagsJson) as Array<{ shortcode: string; url: string }>;
        for (const et of parsed) {
          if (!et.shortcode || !et.url) continue;
          emojiTagObjects.push(new APEmoji({
            id: new URL(et.url),
            name: `:${et.shortcode}:`,
            icon: new Image({ url: new URL(et.url), mediaType: 'image/png' }),
          }));
        }
      } catch { /* ignore */ }
    }

    const allTags = [...mentionTags, ...hashtagTags, ...emojiTagObjects];
    if (allTags.length > 0) {
      noteValues.tags = allTags;
    }

    if (mediaAttachmentObjects.length > 0) {
      noteValues.attachments = mediaAttachmentObjects;
    }

    // Source (raw text) -- standard AP property
    if (statusText) {
      noteValues.source = new Source({
        content: statusText,
        mediaType: 'text/plain',
      });
    }

    // FEP-e232: Quote post
    if (quoteUri) {
      noteValues.quoteUrl = new URL(quoteUri);
    }

    // Conversation context
    if (conversationApUri) {
      noteValues.contexts = [new URL(conversationApUri)];
    }

    const fedifyNote = new Note(noteValues);

    // -- Build Create activity --
    const create = new Create({
      id: new URL(`https://${domain}/activities/${generateUlid()}`),
      actor: new URL(actorUri),
      object: fedifyNote,
      published: Temporal.Instant.from(now),
      tos: toUrls,
      ccs: ccUrls,
    });

    // -- Send via Fedify --
    const fed = c.get('federation');
    const deliveredRecipients = new Set<string>();

    // Deliver to each mentioned remote user
    for (const rm of resolvedMentions) {
      if (rm.mentionDomain && rm.actor_uri) {
        if (!deliveredRecipients.has(rm.actor_uri)) {
          deliveredRecipients.add(rm.actor_uri);
          await sendToRecipient(fed, c.env, currentAccount.username, rm.actor_uri, create);
        }
      }
    }

    if (visibility === 'public' || visibility === 'unlisted') {
      // Fanout to all followers
      await sendToFollowers(fed, c.env, currentAccount.username, create);

      // If this is a reply to a remote user, also deliver directly
      if (inReplyToAccountId) {
        const parentAuthor = await c.env.DB.prepare(
          'SELECT id, domain, uri FROM accounts WHERE id = ?1',
        ).bind(inReplyToAccountId).first();
        if (parentAuthor && parentAuthor.domain && parentAuthor.uri) {
          const parentActorUri = parentAuthor.uri as string;
          if (!deliveredRecipients.has(parentActorUri)) {
            await sendToRecipient(fed, c.env, currentAccount.username, parentActorUri, create);
          }
        }
      }
    } else if (visibility === 'private') {
      // Private: send to followers only (no public fanout, but followers get it)
      await sendToFollowers(fed, c.env, currentAccount.username, create);
    }
    // For 'direct': only the mentioned recipients above get the delivery
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
    emojis: resolvedEmojiTags,
    card: null,
    poll: null,
    edited_at: null,
  });
});

export default app;
