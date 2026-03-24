import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { buildUpdateActivity } from '../../../../federation/activityBuilder';
import { enqueueFanout } from '../../../../federation/deliveryManager';
import { serializeNote } from '../../../../federation/noteSerializer';
import type { StatusRow, AccountRow } from '../../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** Minimal HTML rendering: escape HTML and wrap in <p> */
function renderContent(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const withBr = escaped.replace(/\n/g, '<br/>');
  return `<p>${withBr}</p>`;
}

/** Extract @mentions from text */
function extractMentions(text: string): string[] {
  const re = /@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/g;
  const mentions: string[] = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

/** Extract #hashtags from text */
function extractHashtags(text: string): string[] {
  const re = /#([a-zA-Z0-9_]+)/g;
  const tags: string[] = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  return tags;
}

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

const app = new Hono<HonoEnv>();

app.put('/:id', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccountId = currentUser.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  // Fetch existing status
  const row = await c.env.DB.prepare(
    'SELECT * FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(statusId).first();

  if (!row) throw new AppError(404, 'Record not found');
  if (row.account_id !== currentAccountId) throw new AppError(403, 'This action is not allowed');

  let body: {
    status?: string;
    sensitive?: boolean;
    spoiler_text?: string;
    language?: string;
    media_ids?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const now = new Date().toISOString();
  const statusText = body.status !== undefined ? body.status.trim() : (row.text as string);
  const sensitive = body.sensitive !== undefined ? (body.sensitive ? 1 : 0) : (row.sensitive as number);
  const spoilerText = body.spoiler_text !== undefined ? body.spoiler_text : (row.content_warning as string) || '';
  const language = body.language !== undefined ? body.language : (row.language as string) || 'en';
  const content = renderContent(statusText);
  const mediaIds = body.media_ids || [];

  const stmts = [
    c.env.DB.prepare(
      `UPDATE statuses SET text = ?1, content = ?2, content_warning = ?3, sensitive = ?4, language = ?5, edited_at = ?6, updated_at = ?6 WHERE id = ?7`,
    ).bind(statusText, content, spoilerText, sensitive, language, now, statusId),
  ];

  // Link new media attachments if provided
  for (const mediaId of mediaIds) {
    stmts.push(
      c.env.DB.prepare('UPDATE media_attachments SET status_id = ?1 WHERE id = ?2 AND account_id = ?3')
        .bind(statusId, mediaId, currentAccountId),
    );
  }

  await c.env.DB.batch(stmts);

  // Re-process hashtags: clear old ones, insert new ones
  const hashtags = extractHashtags(statusText);
  await c.env.DB.prepare('DELETE FROM status_tags WHERE status_id = ?1').bind(statusId).run();
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

  // Re-process mentions: clear old ones, insert new ones
  await c.env.DB.prepare('DELETE FROM mentions WHERE status_id = ?1').bind(statusId).run();
  const mentionUsernames = extractMentions(statusText);
  for (const username of mentionUsernames) {
    const mentioned = await c.env.DB.prepare(
      'SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL',
    ).bind(username).first();
    if (mentioned) {
      const mentionId = generateULID();
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO mentions (id, status_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(mentionId, statusId, mentioned.id as string, now).run();
    }
  }

  // Fetch full account data for response
  const accountRow = await c.env.DB.prepare(
    'SELECT * FROM accounts WHERE id = ?1',
  ).bind(currentAccountId).first();

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

  // Federation: deliver Update(Note) to followers if status is local
  if (row.local === 1) {
    try {
      const updatedRow = await c.env.DB.prepare(
        'SELECT * FROM statuses WHERE id = ?1',
      ).bind(statusId).first();
      if (updatedRow && accountRow) {
        let editConvApUri: string | null = null;
        if (updatedRow.conversation_id) {
          const convRow = await c.env.DB.prepare('SELECT ap_uri FROM conversations WHERE id = ?1').bind(updatedRow.conversation_id).first<{ ap_uri: string | null }>();
          editConvApUri = convRow?.ap_uri ?? null;
        }
        const note = serializeNote(
          updatedRow as unknown as StatusRow,
          accountRow as unknown as AccountRow,
          domain,
          { conversationApUri: editConvApUri },
        );
        // Override inReplyTo with parent URI
        if (updatedRow.in_reply_to_id) {
          const parentUri = await c.env.DB.prepare('SELECT uri FROM statuses WHERE id = ?1').bind(updatedRow.in_reply_to_id).first<{ uri: string }>();
          if (parentUri) note.inReplyTo = parentUri.uri;
        }
        const actorUri = (accountRow.uri as string) || `https://${domain}/users/${acct}`;
        const activity = buildUpdateActivity(actorUri, note);
        await enqueueFanout(c.env.QUEUE_FEDERATION, JSON.stringify(activity), currentAccountId);
      }
    } catch (e) {
      console.error('Federation delivery failed for status edit:', e);
    }
  }

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

  return c.json({
    id: statusId,
    created_at: row.created_at as string,
    in_reply_to_id: (row.in_reply_to_id as string) || null,
    in_reply_to_account_id: (row.in_reply_to_account_id as string) || null,
    sensitive: !!sensitive,
    spoiler_text: spoilerText,
    visibility: (row.visibility as string) || 'public',
    language,
    uri: row.uri as string,
    url: (row.url as string) || null,
    replies_count: (row.replies_count as number) || 0,
    reblogs_count: (row.reblogs_count as number) || 0,
    favourites_count: (row.favourites_count as number) || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    content,
    reblog: null,
    application: null,
    account: accountData,
    media_attachments: mediaAttachments,
    mentions: [],
    tags: hashtags.map((t) => ({ name: t, url: `https://${domain}/tags/${t}` })),
    emojis: [],
    card: null,
    poll: null,
    edited_at: now,
  });
});

export default app;
