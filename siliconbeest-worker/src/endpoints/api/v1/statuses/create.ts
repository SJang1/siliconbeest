import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

/** Minimal HTML rendering: escape HTML and wrap in <p> */
function renderContent(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Convert newlines to <br>
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
  const content = renderContent(statusText);
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

  if (!conversationId) {
    conversationId = generateULID();
    await c.env.DB.prepare(
      'INSERT INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
    ).bind(conversationId, now).run();
  }

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id, text, content, content_warning, visibility, sensitive, language, conversation_id, reply, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, ?15, ?15)`,
    ).bind(
      statusId, statusUri, statusUrl, currentUser.account_id,
      inReplyToId, inReplyToAccountId,
      statusText, content, spoilerText, visibility, sensitive, language,
      conversationId, isReply, now,
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

  await c.env.DB.batch(stmts);

  // Handle hashtags
  const hashtags = extractHashtags(statusText);
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

  // Handle mentions
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
    application: null,
    account: {
      id: currentUser.account_id,
      username: currentAccount.username,
      acct: currentAccount.username,
      display_name: '',
      locked: false,
      bot: false,
      discoverable: true,
      group: false,
      created_at: now,
      note: '',
      url: `https://${domain}/@${currentAccount.username}`,
      uri: `https://${domain}/users/${currentAccount.username}`,
      avatar: '',
      avatar_static: '',
      header: '',
      header_static: '',
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      last_status_at: null,
      emojis: [],
      fields: [],
    },
    media_attachments: mediaAttachments,
    mentions: [],
    tags: hashtags.map((t) => ({ name: t, url: `https://${domain}/tags/${t}` })),
    emojis: [],
    card: null,
    poll: null,
    edited_at: null,
  });
});

export default app;
