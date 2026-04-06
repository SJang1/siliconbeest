import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';

const app = new Hono<{ Variables: AppVariables }>();

/**
 * GET /api/v1/custom_emojis — Return all visible custom emojis.
 * Public endpoint, no auth required.
 */
app.get('/', async (c) => {
  const domain = env.INSTANCE_DOMAIN;

  const { results } = await env.DB.prepare(
    `SELECT * FROM custom_emojis
     WHERE visible_in_picker = 1 AND (domain IS NULL OR domain = ?1)
     ORDER BY category ASC, shortcode ASC`,
  ).bind(domain).all();

  const emojis = (results ?? []).map((row: any) => ({
    shortcode: row.shortcode as string,
    url: `https://${domain}/media/${row.image_key}`,
    static_url: `https://${domain}/media/${row.image_key}`,
    visible_in_picker: true,
    category: (row.category as string) || null,
  }));

  return c.json(emojis);
});

export default app;
