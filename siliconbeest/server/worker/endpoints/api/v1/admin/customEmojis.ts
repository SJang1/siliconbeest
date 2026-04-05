import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import {
	listCustomEmojis,
	checkEmojiShortcodeExists,
	createCustomEmoji,
	updateCustomEmoji,
	deleteCustomEmoji,
	getCustomEmoji,
} from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/custom_emojis — List all emojis (including hidden).
 */
app.get('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;
  const results = await listCustomEmojis(c.env.DB, domain);
  return c.json(results.map((row: any) => formatEmoji(row, domain)));
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

  // Check for duplicate shortcode
  const exists = await checkEmojiShortcodeExists(c.env.DB, shortcode, c.env.INSTANCE_DOMAIN);
  if (exists) {
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
  const row = await createCustomEmoji(c.env.DB, {
    id,
    shortcode: shortcode.trim(),
    domain: c.env.INSTANCE_DOMAIN,
    imageKey,
    category,
  });

  return c.json(formatEmoji(row, domain), 200);
});

/**
 * PATCH /api/v1/admin/custom_emojis/:id — Update category/visibility.
 */
app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  const body = await c.req.json<{
    category?: string | null;
    visible_in_picker?: boolean;
  }>();

  const row = await updateCustomEmoji(c.env.DB, id, body);
  return c.json(formatEmoji(row, domain));
});

/**
 * DELETE /api/v1/admin/custom_emojis/:id — Delete emoji (remove from R2 + DB).
 */
app.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const imageKey = await deleteCustomEmoji(c.env.DB, id);

  // Delete from R2
  if (imageKey) {
    await c.env.MEDIA_BUCKET.delete(imageKey);
  }

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
