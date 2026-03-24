import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/custom_emojis — List all emojis (including hidden).
 */
app.get('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM custom_emojis
     WHERE domain IS NULL OR domain = ?1
     ORDER BY category ASC, shortcode ASC`,
  ).bind(domain).all();

  return c.json((results ?? []).map((row: any) => formatEmoji(row, domain)));
});

/**
 * POST /api/v1/admin/custom_emojis — Upload a new emoji.
 * Accepts multipart/form-data with fields: shortcode, image (file), category (optional).
 */
app.post('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;
  const formData = await c.req.formData();

  const shortcode = formData.get('shortcode') as string | null;
  const imageFile = formData.get('image') as File | null;
  const category = (formData.get('category') as string | null) || null;

  if (!shortcode || !shortcode.trim()) {
    throw new AppError(422, 'shortcode is required');
  }
  if (!imageFile) {
    throw new AppError(422, 'image is required');
  }

  // Validate shortcode format (alphanumeric + underscores)
  if (!/^[a-zA-Z0-9_]+$/.test(shortcode)) {
    throw new AppError(422, 'shortcode must contain only letters, numbers, and underscores');
  }

  // Check for duplicate shortcode (local emojis: domain IS NULL or domain = INSTANCE_DOMAIN)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM custom_emojis WHERE shortcode = ?1 AND (domain IS NULL OR domain = ?2)',
  ).bind(shortcode, c.env.INSTANCE_DOMAIN).first();

  if (existing) {
    throw new AppError(422, 'shortcode already exists');
  }

  // Upload image to R2
  const id = generateUlid();
  const ext = imageFile.name?.split('.').pop() || 'png';
  const imageKey = `emoji/${id}.${ext}`;

  const arrayBuffer = await imageFile.arrayBuffer();
  await c.env.MEDIA_BUCKET.put(imageKey, arrayBuffer, {
    httpMetadata: {
      contentType: imageFile.type || 'image/png',
    },
  });

  // Insert into DB
  const now = new Date().toISOString();
  const instanceDomain = c.env.INSTANCE_DOMAIN;
  await c.env.DB.prepare(
    `INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, category, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)`,
  ).bind(id, shortcode.trim(), instanceDomain, imageKey, category, now, now).run();

  const row = await c.env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
  return c.json(formatEmoji(row!, domain), 200);
});

/**
 * PATCH /api/v1/admin/custom_emojis/:id — Update category/visibility.
 */
app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  const existing = await c.env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
  if (!existing) throw new AppError(404, 'Record not found');

  const body = await c.req.json<{
    category?: string | null;
    visible_in_picker?: boolean;
  }>();

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE custom_emojis SET
       category = ?1,
       visible_in_picker = ?2,
       updated_at = ?3
     WHERE id = ?4`,
  ).bind(
    body.category !== undefined ? body.category : existing.category,
    body.visible_in_picker !== undefined ? (body.visible_in_picker ? 1 : 0) : existing.visible_in_picker,
    now,
    id,
  ).run();

  const row = await c.env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
  return c.json(formatEmoji(row!, domain));
});

/**
 * DELETE /api/v1/admin/custom_emojis/:id — Delete emoji (remove from R2 + DB).
 */
app.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
  if (!existing) throw new AppError(404, 'Record not found');

  // Delete from R2
  const imageKey = existing.image_key as string;
  if (imageKey) {
    await c.env.MEDIA_BUCKET.delete(imageKey);
  }

  // Delete from DB
  await c.env.DB.prepare('DELETE FROM custom_emojis WHERE id = ?1').bind(id).run();

  return c.json({}, 200);
});

function formatEmoji(row: Record<string, unknown>, domain: string) {
  return {
    id: row.id as string,
    shortcode: row.shortcode as string,
    url: `https://${domain}/media/${row.image_key}`,
    static_url: `https://${domain}/media/${row.image_key}`,
    visible_in_picker: !!(row.visible_in_picker),
    category: (row.category as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export default app;
