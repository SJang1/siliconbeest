import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authOptional } from '../../../../middleware/auth';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/trends/links — trending links
app.get('/', authOptional, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 40);
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  // Fetch the most-shared preview cards from recent statuses
  const { results } = await env.DB.prepare(
    `SELECT pc.url, pc.title, pc.description, pc.image_url, pc.type,
       pc.author_name, pc.author_url, pc.provider_name, pc.provider_url,
       pc.blurhash, pc.width, pc.height,
       COUNT(DISTINCT s.id) AS usage_count
     FROM preview_cards pc
     JOIN status_preview_cards spc ON spc.preview_card_id = pc.id
     JOIN statuses s ON s.id = spc.status_id
     WHERE s.deleted_at IS NULL
       AND s.visibility IN ('public', 'unlisted')
       AND s.created_at >= datetime('now', '-7 days')
       AND pc.title IS NOT NULL AND pc.title != ''
     GROUP BY pc.id
     ORDER BY usage_count DESC
     LIMIT ?1 OFFSET ?2`,
  )
    .bind(limit, offset)
    .all();

  const links = (results ?? []).map((r: any) => ({
    url: r.url,
    title: r.title || '',
    description: r.description || '',
    type: r.type || 'link',
    author_name: r.author_name || '',
    author_url: r.author_url || '',
    provider_name: r.provider_name || '',
    provider_url: r.provider_url || '',
    html: '',
    width: r.width || 0,
    height: r.height || 0,
    image: r.image_url || null,
    image_description: '',
    embed_url: '',
    blurhash: r.blurhash || null,
    history: [],
  }));

  return c.json(links);
});

export default app;
