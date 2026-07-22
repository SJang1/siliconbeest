import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import type { AdvertisementFormat, AdvertisementRow } from '../../../../types/db';
import { AppError } from '../../../../middleware/errorHandler';
import { adminOnlyRequired, authRequired } from '../../../../middleware/auth';
import { requireScopeForMethod } from '../../../../middleware/scopeCheck';
import { generateUlid } from '../../../../utils/ulid';

type HonoEnv = { Variables: AppVariables };

type AdvertisementWithImageRow = AdvertisementRow & {
  readonly image_file_key: string | null;
};

type AdvertisementInput = {
  readonly format?: unknown;
  readonly text?: unknown;
  readonly image_media_attachment_id?: unknown;
  readonly image_alt_text?: unknown;
  readonly status_ref?: unknown;
  readonly link_url?: unknown;
  readonly enabled?: unknown;
  readonly starts_at?: unknown;
  readonly ends_at?: unknown;
};

const FORMATS = new Set<AdvertisementFormat>(['text', 'image', 'text_image', 'status']);
const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminOnlyRequired);
app.use('*', requireScopeForMethod('admin:read', 'admin:write'));

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDate(value: unknown, field: string): string | null {
  const text = nullableString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AppError(422, `${field} is invalid`);
  return date.toISOString();
}

function parseStatusRef(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.at(-1) ?? null;
  } catch {
    return text;
  }
}

function parseLinkUrl(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppError(422, 'link_url is invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(422, 'link_url must use http or https');
  }
  return url.toString();
}

function formatAdvertisement(row: AdvertisementWithImageRow) {
  return {
    id: row.id,
    format: row.format,
    text: row.text,
    image_media_attachment_id: row.image_media_attachment_id,
    image_url: row.image_file_key
      ? `https://${env.INSTANCE_DOMAIN}/media/${row.image_file_key}`
      : null,
    image_alt_text: row.image_alt_text,
    status_id: row.status_id,
    link_url: row.link_url,
    enabled: !!row.enabled,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getAdvertisement(id: string): Promise<AdvertisementWithImageRow> {
  const row = await env.DB_META_C000.prepare(
    `SELECT ad.*, media.file_key AS image_file_key
     FROM advertisements ad
     LEFT JOIN media_attachments media ON media.id = ad.image_media_attachment_id
     WHERE ad.id = ?1`,
  ).bind(id).first<AdvertisementWithImageRow>();
  if (!row) throw new AppError(404, 'Advertisement not found');
  return row;
}

async function validateInput(
  input: AdvertisementInput,
  currentAccountId: string,
  existing?: AdvertisementRow,
) {
  const format = input.format ?? existing?.format;
  if (typeof format !== 'string' || !FORMATS.has(format as AdvertisementFormat)) {
    throw new AppError(422, 'format is invalid');
  }

  const text = input.text === undefined ? existing?.text ?? null : nullableString(input.text);
  const imageMediaAttachmentId = input.image_media_attachment_id === undefined
    ? existing?.image_media_attachment_id ?? null
    : nullableString(input.image_media_attachment_id);
  const imageAltText = input.image_alt_text === undefined
    ? existing?.image_alt_text ?? ''
    : nullableString(input.image_alt_text) ?? '';
  const statusId = input.status_ref === undefined
    ? existing?.status_id ?? null
    : parseStatusRef(input.status_ref);
  const linkUrl = input.link_url === undefined
    ? existing?.link_url ?? null
    : parseLinkUrl(input.link_url);
  const enabled = input.enabled === undefined
    ? existing?.enabled ?? 1
    : input.enabled === true ? 1 : 0;
  const startsAt = input.starts_at === undefined
    ? existing?.starts_at ?? null
    : parseDate(input.starts_at, 'starts_at');
  const endsAt = input.ends_at === undefined
    ? existing?.ends_at ?? null
    : parseDate(input.ends_at, 'ends_at');

  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new AppError(422, 'ends_at must be after starts_at');
  }
  if ((format === 'text' || format === 'text_image') && !text) {
    throw new AppError(422, 'text is required for this format');
  }
  if (format === 'image' || format === 'text_image') {
    if (!imageMediaAttachmentId) {
      throw new AppError(422, 'image_media_attachment_id is required for this format');
    }
    const media = await env.DB_META_C000.prepare(
      `SELECT id, account_id, type
       FROM media_attachments
       WHERE id = ?1`,
    ).bind(imageMediaAttachmentId).first<{
      id: string;
      account_id: string;
      type: string;
    }>();
    const isExistingImage = existing?.image_media_attachment_id === imageMediaAttachmentId;
    if (!media || !['image', 'gifv'].includes(media.type)) {
      throw new AppError(422, 'The selected media is not an image');
    }
    if (!isExistingImage && media.account_id !== currentAccountId) {
      throw new AppError(403, 'The selected media does not belong to this administrator');
    }
  }
  if (format === 'status') {
    if (!statusId) throw new AppError(422, 'status_ref is required for this format');
    const status = await env.DB_META_C000.prepare(
      `SELECT id FROM statuses
       WHERE id = ?1
         AND visibility = 'public'
         AND deleted_at IS NULL
         AND reblog_of_id IS NULL`,
    ).bind(statusId).first<{ id: string }>();
    if (!status) throw new AppError(422, 'The advertised post must be an existing public post');
  }

  return {
    format: format as AdvertisementFormat,
    text: format === 'text' || format === 'text_image' ? text : null,
    imageMediaAttachmentId: format === 'image' || format === 'text_image'
      ? imageMediaAttachmentId
      : null,
    imageAltText: format === 'image' || format === 'text_image' ? imageAltText : '',
    statusId: format === 'status' ? statusId : null,
    linkUrl,
    enabled,
    startsAt,
    endsAt,
  };
}

app.get('/', async (c) => {
  const { results } = await env.DB_META_C000.prepare(
    `SELECT ad.*, media.file_key AS image_file_key
     FROM advertisements ad
     LEFT JOIN media_attachments media ON media.id = ad.image_media_attachment_id
     ORDER BY ad.created_at DESC
     LIMIT 200`,
  ).all<AdvertisementWithImageRow>();
  return c.json((results ?? []).map(formatAdvertisement));
});

app.post('/', async (c) => {
  const currentUser = c.get('currentUser')!;
  const input = await c.req.json<AdvertisementInput>();
  const values = await validateInput(input, currentUser.account_id);
  const id = generateUlid();
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO advertisements (
       id, format, text, image_media_attachment_id, image_alt_text,
       status_id, link_url, enabled, starts_at, ends_at,
       created_by_account_id, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  ).bind(
    id,
    values.format,
    values.text,
    values.imageMediaAttachmentId,
    values.imageAltText,
    values.statusId,
    values.linkUrl,
    values.enabled,
    values.startsAt,
    values.endsAt,
    currentUser.account_id,
    now,
  ).run();
  return c.json(formatAdvertisement(await getAdvertisement(id)), 201);
});

app.put('/:id', async (c) => {
  const currentUser = c.get('currentUser')!;
  const existing = await getAdvertisement(c.req.param('id'));
  const input = await c.req.json<AdvertisementInput>();
  const values = await validateInput(input, currentUser.account_id, existing);
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `UPDATE advertisements
     SET format = ?1,
         text = ?2,
         image_media_attachment_id = ?3,
         image_alt_text = ?4,
         status_id = ?5,
         link_url = ?6,
         enabled = ?7,
         starts_at = ?8,
         ends_at = ?9,
         updated_at = ?10
     WHERE id = ?11`,
  ).bind(
    values.format,
    values.text,
    values.imageMediaAttachmentId,
    values.imageAltText,
    values.statusId,
    values.linkUrl,
    values.enabled,
    values.startsAt,
    values.endsAt,
    now,
    existing.id,
  ).run();
  return c.json(formatAdvertisement(await getAdvertisement(existing.id)));
});

app.delete('/:id', async (c) => {
  await getAdvertisement(c.req.param('id'));
  await env.DB_META_C000.prepare('DELETE FROM advertisements WHERE id = ?1')
    .bind(c.req.param('id'))
    .run();
  return c.json({});
});

export default app;
