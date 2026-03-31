import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import { serializeMediaAttachment } from '../../../utils/mastodonSerializer';
import type { MediaAttachmentRow } from '../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
};

function mediaTypeFromMime(mime: string): string {
  if (mime.startsWith('image/')) return mime === 'image/gif' ? 'gifv' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

const app = new Hono<HonoEnv>();

// POST /api/v2/media — async media upload
app.post('/', authRequired, requireScope('write:media'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new AppError(422, 'Validation failed', 'file is required');
  }

  const description = (formData.get('description') as string) || '';
  const focus = (formData.get('focus') as string) || '0.0,0.0';

  const contentType = file.type;
  const ext = ALLOWED_MIME_TYPES[contentType];
  if (!ext) {
    throw new AppError(422, 'Validation failed', 'Unsupported file type');
  }

  const mediaId = generateUlid();
  const fileKey = `${currentUser.account_id}/${mediaId}.${ext}`;
  const now = new Date().toISOString();
  const type = mediaTypeFromMime(contentType);

  // Upload to R2
  const arrayBuffer = await file.arrayBuffer();
  await c.env.MEDIA_BUCKET.put(fileKey, arrayBuffer, {
    httpMetadata: { contentType },
  });

  // Insert media_attachments row
  await c.env.DB.prepare(
    `INSERT INTO media_attachments
       (id, status_id, account_id, file_key, file_content_type, file_size,
        thumbnail_key, remote_url, description, blurhash, width, height, type,
        created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, ?4, ?5, NULL, NULL, ?6, NULL, NULL, NULL, ?7, ?8, ?8)`,
  )
    .bind(
      mediaId,
      currentUser.account_id,
      fileKey,
      contentType,
      arrayBuffer.byteLength,
      description,
      type,
      now,
    )
    .run();

  // Enqueue process_media for thumbnail/metadata extraction
  await c.env.QUEUE_INTERNAL.send({
    type: 'process_media',
    mediaAttachmentId: mediaId,
    accountId: currentUser.account_id,
  });

  const mediaUrl = `https://${domain}/media/${fileKey}`;

  return c.json(
    {
      id: mediaId,
      type,
      url: mediaUrl,
      preview_url: mediaUrl,
      remote_url: null,
      text_url: null,
      meta: null,
      description: description || null,
      blurhash: null,
    },
    202,
  );
});

// GET /api/v1/media/:id — check upload status
app.get('/:id', authRequired, requireScope('read:media'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;
  const mediaId = c.req.param('id');

  const row = await c.env.DB.prepare(
    'SELECT * FROM media_attachments WHERE id = ?1 AND account_id = ?2',
  )
    .bind(mediaId, currentUser.account_id)
    .first<MediaAttachmentRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  const mediaUrl = `https://${domain}/media/${row.file_key}`;
  const previewUrl = row.thumbnail_key
    ? `https://${domain}/media/${row.thumbnail_key}`
    : mediaUrl;

  return c.json({
    id: row.id,
    type: row.type,
    url: mediaUrl,
    preview_url: previewUrl,
    remote_url: row.remote_url ?? null,
    text_url: null,
    meta:
      row.width != null && row.height != null
        ? { original: { width: row.width, height: row.height } }
        : null,
    description: row.description || null,
    blurhash: row.blurhash ?? null,
  });
});

// PUT /api/v1/media/:id — update description/focus
app.put('/:id', authRequired, requireScope('write:media'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;
  const mediaId = c.req.param('id');

  let body: { description?: string; focus?: string };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const row = await c.env.DB.prepare(
    'SELECT * FROM media_attachments WHERE id = ?1 AND account_id = ?2',
  )
    .bind(mediaId, currentUser.account_id)
    .first<MediaAttachmentRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  const now = new Date().toISOString();
  const newDescription =
    body.description !== undefined ? body.description : row.description;

  await c.env.DB.prepare(
    'UPDATE media_attachments SET description = ?1, updated_at = ?2 WHERE id = ?3',
  )
    .bind(newDescription, now, mediaId)
    .run();

  const mediaUrl = `https://${domain}/media/${row.file_key}`;
  const previewUrl = row.thumbnail_key
    ? `https://${domain}/media/${row.thumbnail_key}`
    : mediaUrl;

  return c.json({
    id: row.id,
    type: row.type,
    url: mediaUrl,
    preview_url: previewUrl,
    remote_url: row.remote_url ?? null,
    text_url: null,
    meta:
      row.width != null && row.height != null
        ? { original: { width: row.width, height: row.height } }
        : null,
    description: newDescription || null,
    blurhash: row.blurhash ?? null,
  });
});

export default app;
