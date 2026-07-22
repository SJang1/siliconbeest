import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import type { AdvertisementRow } from '../../../types/db';
import { authOptional } from '../../../middleware/auth';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './statuses/fetch';

type HonoEnv = { Variables: AppVariables };

type PublicAdvertisementRow = AdvertisementRow & {
  readonly image_file_key: string | null;
};

const app = new Hono<HonoEnv>();

/** GET /api/v1/ads — active timeline advertisements for this viewer. */
app.get('/', authOptional, async (c) => {
  const now = new Date().toISOString();
  const currentAccountId = c.get('currentUser')?.account_id ?? null;
  const { results } = await env.DB_META_C000.prepare(
    `SELECT ad.*, media.file_key AS image_file_key
     FROM advertisements ad
     LEFT JOIN media_attachments media
       ON media.id = ad.image_media_attachment_id
     WHERE ad.enabled = 1
       AND (ad.starts_at IS NULL OR ad.starts_at <= ?1)
       AND (ad.ends_at IS NULL OR ad.ends_at > ?1)
     ORDER BY ad.created_at DESC
     LIMIT 50`,
  ).bind(now).all<PublicAdvertisementRow>();

  const advertisements = await Promise.all((results ?? []).map(async (row) => {
    if ((row.format === 'image' || row.format === 'text_image') && !row.image_file_key) {
      return null;
    }

    let status = null;
    if (row.format === 'status') {
      if (!row.status_id) return null;
      const statusRow = await env.DB_META_C000.prepare(
        `${STATUS_JOIN_SQL}
         WHERE s.id = ?1
           AND s.visibility = 'public'
           AND s.deleted_at IS NULL
           AND s.reblog_of_id IS NULL`,
      ).bind(row.status_id).first<Record<string, unknown>>();
      if (!statusRow) return null;
      status = await serializeStatusEnriched(
        statusRow,
        env.INSTANCE_DOMAIN,
        currentAccountId,
        env.CACHE,
      );
    }

    return {
      id: row.id,
      format: row.format,
      text: row.text,
      image_url: row.image_file_key
        ? `https://${env.INSTANCE_DOMAIN}/media/${row.image_file_key}`
        : null,
      image_alt_text: row.image_alt_text,
      link_url: row.link_url,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      status,
    };
  }));

  c.header('Cache-Control', 'private, no-store');
  return c.json(advertisements.filter((ad) => ad !== null));
});

export default app;
