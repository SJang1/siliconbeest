import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import type { StatusEditRow, MediaAttachmentRow } from '../../../../types/db';

type HonoEnv = { Variables: AppVariables };

interface StatusWithAccountRow {
  id: string;
  account_id: string;
  content: string;
  content_warning: string;
  sensitive: number;
  created_at: string;
  edited_at: string | null;
  username: string;
  account_domain: string | null;
  display_name: string;
  account_uri: string | null;
  account_url: string | null;
  avatar_url: string | null;
  avatar_static_url: string | null;
  header_url: string | null;
  header_static_url: string | null;
  locked: number;
  bot: number;
  discoverable: number | null;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  account_created_at: string;
}

const app = new Hono<HonoEnv>();

// GET /api/v1/statuses/:id/history — get edit history
app.get('/:id/history', authOptional, async (c) => {
  const statusId = c.req.param('id');
  const domain = env.INSTANCE_DOMAIN;

  const status = await env.DB.prepare(
    `SELECT s.*, a.username, a.domain AS account_domain, a.display_name, a.note AS account_note,
       a.uri AS account_uri, a.url AS account_url,
       a.avatar_url, a.avatar_static_url, a.header_url, a.header_static_url,
       a.locked, a.bot, a.discoverable,
       a.followers_count, a.following_count, a.statuses_count,
       a.created_at AS account_created_at
     FROM statuses s JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  )
    .bind(statusId)
    .first<StatusWithAccountRow>();

  if (!status) throw new AppError(404, 'Record not found');

  const acct = status.account_domain
    ? `${status.username}@${status.account_domain}`
    : status.username;

  const account = {
    id: status.account_id,
    username: status.username,
    acct,
    display_name: status.display_name || '',
    url: status.account_url || `https://${domain}/@${status.username}`,
    uri: status.account_uri,
    avatar: status.avatar_url || '',
    avatar_static: status.avatar_static_url || status.avatar_url || '',
    header: status.header_url || '',
    header_static: status.header_static_url || status.header_url || '',
  };

  // Fetch edit history from status_edits table
  const { results: edits } = await env.DB.prepare(
    `SELECT * FROM status_edits WHERE status_id = ?1 ORDER BY created_at ASC`,
  )
    .bind(statusId)
    .all<StatusEditRow>();

  // Fetch media attachments for this status
  const { results: media } = await env.DB.prepare(
    `SELECT * FROM media_attachments WHERE status_id = ?1`,
  )
    .bind(statusId)
    .all<MediaAttachmentRow>();

  const mediaAttachments = (media ?? []).map((m) => ({
    id: m.id,
    type: m.type || 'image',
    url: `https://${domain}/media/${m.file_key}`,
    preview_url: m.thumbnail_key ? `https://${domain}/media/${m.thumbnail_key}` : `https://${domain}/media/${m.file_key}`,
    description: m.description || null,
    blurhash: m.blurhash || null,
  }));

  const history: Array<{
    content: string;
    spoiler_text: string;
    sensitive: boolean;
    created_at: string;
    account: typeof account;
    media_attachments: typeof mediaAttachments;
    emojis: never[];
  }> = [];

  // Add edit snapshots
  for (const e of edits ?? []) {
    let editMedia = mediaAttachments;
    if (e.media_attachments_json) {
      try {
        editMedia = JSON.parse(e.media_attachments_json);
      } catch { /* use current media */ }
    }
    history.push({
      content: e.content,
      spoiler_text: e.spoiler_text || '',
      sensitive: !!e.sensitive,
      created_at: e.created_at,
      account,
      media_attachments: editMedia,
      emojis: [],
    });
  }

  // Always add the current version as the last entry
  history.push({
    content: status.content || '',
    spoiler_text: status.content_warning || '',
    sensitive: !!status.sensitive,
    created_at: status.edited_at || status.created_at,
    account,
    media_attachments: mediaAttachments,
    emojis: [],
  });

  return c.json(history);
});

export default app;
