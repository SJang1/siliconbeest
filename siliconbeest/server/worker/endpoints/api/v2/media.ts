import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import type { MediaAttachmentRow } from '../../../types/db';
import { generateImageAltText } from '../../../services/workersAi';
import { isWorkersAiFeatureEnabled } from '../../../services/workersAiFeatures';
import { consumeWorkersAiRateLimit } from '../../../services/workersAiRateLimit';

type HonoEnv = { Variables: AppVariables };

/** Blocked MIME types that could be harmful or are not media. */
const BLOCKED_MIME_TYPES = new Set([
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'text/html',
  'text/xml',
  'application/xml',
  'application/xhtml+xml',
  'application/x-shockwave-flash',
  'application/x-msdownload',
  'application/x-executable',
  'application/x-dosexec',
  'application/bat',
  'application/x-bat',
  'application/x-msdos-program',
]);

/** Raster formats accepted by the configured Workers AI image caption model. */
const AI_ALT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Keep inference memory/cost bounded without rejecting the underlying upload. */
const AI_ALT_MAX_BYTES = 10 * 1024 * 1024;

type DescriptionGenerationStatus = 'pending' | 'complete' | 'failed' | 'disabled';
type DescriptionGenerationError =
  | 'rate_limited'
  | 'rate_limiter_unavailable'
  | 'generation_failed'
  | 'persistence_failed'
  | 'unknown';

type DescriptionGenerationState = {
  readonly status: DescriptionGenerationStatus;
  readonly error: DescriptionGenerationError | null;
  readonly retryAfterSeconds: number | null;
};

const AI_ALT_STATUS_TTL_SECONDS = 10 * 60;

function descriptionGenerationStatusKey(accountId: string, mediaId: string): string {
  return `workers-ai:media-description:v1:${accountId}:${mediaId}`;
}

function descriptionGenerationState(
  status: DescriptionGenerationStatus,
  error: DescriptionGenerationError | null = null,
  retryAfterSeconds: number | null = null,
): DescriptionGenerationState {
  return { status, error, retryAfterSeconds };
}

async function readDescriptionGenerationState(
  accountId: string,
  mediaId: string,
): Promise<DescriptionGenerationState | null> {
  try {
    const value = await env.CACHE.get(descriptionGenerationStatusKey(accountId, mediaId));
    if (value === 'pending' || value === 'complete' || value === 'disabled') {
      return descriptionGenerationState(value);
    }
    if (value === 'failed') {
      return descriptionGenerationState('failed', 'unknown');
    }
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<DescriptionGenerationState>;
    if (
      parsed.status !== 'pending'
      && parsed.status !== 'complete'
      && parsed.status !== 'failed'
      && parsed.status !== 'disabled'
    ) return null;
    const error = parsed.error === 'rate_limited'
      || parsed.error === 'rate_limiter_unavailable'
      || parsed.error === 'generation_failed'
      || parsed.error === 'persistence_failed'
      || parsed.error === 'unknown'
      ? parsed.error
      : parsed.status === 'failed' ? 'unknown' : null;
    const retryAfterSeconds = typeof parsed.retryAfterSeconds === 'number'
      && Number.isSafeInteger(parsed.retryAfterSeconds)
      && parsed.retryAfterSeconds > 0
      ? parsed.retryAfterSeconds
      : null;
    return descriptionGenerationState(parsed.status, error, retryAfterSeconds);
  } catch {
    return null;
  }
}

async function writeDescriptionGenerationStatus(
  accountId: string,
  mediaId: string,
  status: DescriptionGenerationStatus,
  options?: {
    readonly error?: DescriptionGenerationError;
    readonly retryAfterSeconds?: number;
  },
): Promise<void> {
  try {
    await env.CACHE.put(
      descriptionGenerationStatusKey(accountId, mediaId),
      JSON.stringify(descriptionGenerationState(
        status,
        options?.error ?? null,
        options?.retryAfterSeconds ?? null,
      )),
      { expirationTtl: AI_ALT_STATUS_TTL_SECONDS },
    );
  } catch {
    // Generation status is a progressive-enhancement hint. Uploads and manual
    // ALT editing must keep working if KV is temporarily unavailable.
  }
}

function logDescriptionGenerationFailure(
  mediaId: string,
  error: DescriptionGenerationError,
  retryAfterSeconds?: number,
): void {
  console.warn('[workers-ai]', JSON.stringify({
    event: 'image_alt_generation_failed',
    mediaId,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  }));
}

async function generateAndPersistImageDescription(input: {
  readonly accountId: string;
  readonly mediaId: string;
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}): Promise<void> {
  const { accountId, mediaId, bytes, contentType } = input;

  try {
    const rateLimit = await consumeWorkersAiRateLimit('imageDescription', accountId);
    if (!rateLimit.allowed) {
      const error = rateLimit.reason === 'limited'
        ? 'rate_limited'
        : 'rate_limiter_unavailable';
      logDescriptionGenerationFailure(mediaId, error, rateLimit.retryAfterSeconds);
      await writeDescriptionGenerationStatus(accountId, mediaId, 'failed', {
        error,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }

    // Pass the uploaded bytes directly. This works with local/private R2 as
    // well as production and avoids depending on a public media URL.
    const generatedDescription = await generateImageAltText(bytes, contentType, env);
    if (!generatedDescription) {
      logDescriptionGenerationFailure(mediaId, 'generation_failed');
      await writeDescriptionGenerationStatus(accountId, mediaId, 'failed', {
        error: 'generation_failed',
      });
      return;
    }

    try {
      await env.DB.prepare(
        `UPDATE media_attachments
         SET description = ?1, updated_at = ?2
         WHERE id = ?3
           AND account_id = ?4
           AND description IS NULL`,
      )
        .bind(
          generatedDescription,
          new Date().toISOString(),
          mediaId,
          accountId,
        )
        .run();
    } catch (error) {
      console.warn('Workers AI ALT persistence failed; continuing without ALT text', error);
      logDescriptionGenerationFailure(mediaId, 'persistence_failed');
      await writeDescriptionGenerationStatus(accountId, mediaId, 'failed', {
        error: 'persistence_failed',
      });
      return;
    }

    // NULL is reserved for a pending automatic description. Manual saves use
    // a string (including ''), so metadata updates may freely change
    // updated_at without weakening the user's ALT-text precedence.
    await writeDescriptionGenerationStatus(accountId, mediaId, 'complete');
  } catch (error) {
    console.warn('Workers AI ALT generation failed; continuing without ALT text', error);
    logDescriptionGenerationFailure(mediaId, 'generation_failed');
    await writeDescriptionGenerationStatus(accountId, mediaId, 'failed', {
      error: 'generation_failed',
    });
  }
}

/** Well-known extension mappings for common media types. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/opus': 'opus',
};

function extFromMime(mime: string): string {
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  // Fallback: use subtype as extension (e.g. 'image/tiff' → 'tiff')
  const sub = mime.split('/')[1];
  if (sub) return sub.replace(/^x-/, '');
  return 'bin';
}

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
  const domain = env.INSTANCE_DOMAIN;

  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new AppError(422, 'Validation failed', 'file is required');
  }

  const descriptionValue = formData.get('description');
  const description = typeof descriptionValue === 'string' ? descriptionValue : '';
  const _focus = (formData.get('focus') as string) || '0.0,0.0';

  const contentType = file.type;
  if (
    !contentType.startsWith('image/') &&
    !contentType.startsWith('video/') &&
    !contentType.startsWith('audio/')
  ) {
    throw new AppError(422, 'Validation failed', 'Unsupported file type');
  }
  if (BLOCKED_MIME_TYPES.has(contentType)) {
    throw new AppError(422, 'Validation failed', 'Unsupported file type');
  }
  const ext = extFromMime(contentType);

  const mediaId = generateUlid();
  const fileKey = `${currentUser.account_id}/${mediaId}.${ext}`;
  const now = new Date().toISOString();
  const type = mediaTypeFromMime(contentType);

  // Upload to R2
  const arrayBuffer = await file.arrayBuffer();
  await env.MEDIA_BUCKET.put(fileKey, arrayBuffer, {
    httpMetadata: { contentType },
  });
  const mediaUrl = `https://${domain}/media/${fileKey}`;

  const hasClientDescription = description.trim().length > 0;
  const canGenerateDescription =
    !hasClientDescription
    && AI_ALT_MIME_TYPES.has(contentType)
    && arrayBuffer.byteLength <= AI_ALT_MAX_BYTES;
  let shouldGenerateDescription = false;
  if (canGenerateDescription) {
    try {
      shouldGenerateDescription = await isWorkersAiFeatureEnabled('imageDescription');
    } catch (error) {
      // Feature lookup is optional infrastructure. It must not turn a valid
      // upload into an error when AI is disabled or unavailable.
      console.warn('Workers AI ALT feature lookup failed; skipping generation', error);
    }
  }

  // Insert media_attachments row
  await env.DB.prepare(
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
      hasClientDescription
        ? description
        : shouldGenerateDescription
          ? null
          : '',
      type,
      now,
    )
    .run();

  const descriptionGenerationStatus: DescriptionGenerationStatus =
    shouldGenerateDescription ? 'pending' : 'disabled';
  if (shouldGenerateDescription) {
    await writeDescriptionGenerationStatus(
      currentUser.account_id,
      mediaId,
      descriptionGenerationStatus,
    );
    c.executionCtx.waitUntil(generateAndPersistImageDescription({
      accountId: currentUser.account_id,
      mediaId,
      bytes: arrayBuffer,
      contentType,
    }));
  }

  // Enqueue process_media for thumbnail/metadata extraction
  await env.QUEUE_INTERNAL.send({
    type: 'process_media',
    mediaAttachmentId: mediaId,
    accountId: currentUser.account_id,
  });

  return c.json(
    {
      id: mediaId,
      type,
      url: mediaUrl,
      preview_url: mediaUrl,
      remote_url: null,
      text_url: null,
      meta: null,
      description: hasClientDescription ? description : null,
      description_generation_status: descriptionGenerationStatus,
      description_generation_error: null,
      description_generation_retry_after_seconds: null,
      blurhash: null,
    },
    202,
  );
});

// GET /api/v1/media/:id — check upload status
app.get('/:id', authRequired, requireScope('write:media'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = env.INSTANCE_DOMAIN;
  const mediaId = c.req.param('id');

  const row = await env.DB.prepare(
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
  const descriptionState = (row.description?.trim().length ?? 0) > 0
    ? descriptionGenerationState('complete')
    : await readDescriptionGenerationState(currentUser.account_id, mediaId)
      ?? descriptionGenerationState('disabled');

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
    description_generation_status: descriptionState.status,
    description_generation_error: descriptionState.error,
    description_generation_retry_after_seconds: descriptionState.retryAfterSeconds,
    blurhash: row.blurhash ?? null,
  });
});

// PUT /api/v1/media/:id — update description/focus
app.put('/:id', authRequired, requireScope('write:media'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = env.INSTANCE_DOMAIN;
  const mediaId = c.req.param('id');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    throw new AppError(422, 'Validation failed', 'Request body must be an object');
  }
  const bodyRecord = rawBody as Record<string, unknown>;
  if (bodyRecord.description !== undefined && typeof bodyRecord.description !== 'string') {
    throw new AppError(422, 'Validation failed', 'description must be a string');
  }
  if (bodyRecord.focus !== undefined && typeof bodyRecord.focus !== 'string') {
    throw new AppError(422, 'Validation failed', 'focus must be a string');
  }
  const body: { description?: string; focus?: string } = {
    description: bodyRecord.description as string | undefined,
    focus: bodyRecord.focus as string | undefined,
  };

  const row = await env.DB.prepare(
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
  let descriptionState: DescriptionGenerationState;
  if (body.description !== undefined) {
    // Explicit saves always replace the NULL pending sentinel with a string,
    // including an intentional blank, so background AI cannot overwrite it.
    const update = await env.DB.prepare(
      `UPDATE media_attachments
       SET description = ?1, updated_at = ?2
       WHERE id = ?3`,
    )
      .bind(newDescription, now, mediaId)
      .run();
    c.set(
      'contributionApplied',
      (update.meta?.changes ?? 0) > 0 && newDescription !== row.description,
    );
    descriptionState = descriptionGenerationState('complete');
    c.executionCtx.waitUntil(
      writeDescriptionGenerationStatus(currentUser.account_id, mediaId, 'complete'),
    );
  } else {
    c.set('contributionApplied', false);
    descriptionState = (row.description?.trim().length ?? 0) > 0
      ? descriptionGenerationState('complete')
      : await readDescriptionGenerationState(currentUser.account_id, mediaId)
        ?? descriptionGenerationState('disabled');
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
    description: newDescription || null,
    description_generation_status: descriptionState.status,
    description_generation_error: descriptionState.error,
    description_generation_retry_after_seconds: descriptionState.retryAfterSeconds,
    blurhash: row.blurhash ?? null,
  });
});

export default app;
