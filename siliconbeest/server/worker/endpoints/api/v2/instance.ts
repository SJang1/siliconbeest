import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { getTurnstileSettings } from '../../../utils/turnstile';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;

  // Read settings from DB first, fall back to env vars
  const dbSettings: Record<string, string> = {};
  const { results: settingsRows } = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('site_title', 'site_description', 'registration_mode', 'site_contact_email', 'site_contact_username')"
  ).all();
  for (const row of settingsRows ?? []) {
    dbSettings[row.key as string] = row.value as string;
  }

  // Turnstile settings (cached in KV)
  const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);

  const title = dbSettings.site_title || c.env.INSTANCE_TITLE || domain;
  const registrationMode = dbSettings.registration_mode || c.env.REGISTRATION_MODE || 'none';

  // Usage stats
  const userCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL AND suspended_at IS NULL`,
  ).first<{ cnt: number }>();

  const statusCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM statuses WHERE local = 1 AND deleted_at IS NULL`,
  ).first<{ cnt: number }>();

  const domainCount = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL`,
  ).first<{ cnt: number }>();

  // Rules
  const { results: ruleRows } = await c.env.DB.prepare(
    `SELECT id, text FROM rules ORDER BY priority ASC`,
  ).all();

  const rules = (ruleRows ?? []).map((r: any) => ({
    id: r.id,
    text: r.text,
  }));

  return c.json({
    domain,
    title,
    version: '4.0.0 (compatible; SiliconBeest 0.1.0)',
    source_url: 'https://github.com/SJang1/siliconbeest',
    description: dbSettings.site_description || `${title} is powered by SiliconBeest, a serverless Fediverse server.`,
    usage: {
      users: {
        active_month: userCount?.cnt ?? 0,
      },
    },
    thumbnail: {
      url: `https://${domain}/thumbnail.png`,
      blurhash: null,
      versions: {},
    },
    languages: ['en'],
    configuration: {
      urls: {
        streaming: `wss://${domain}/api/v1/streaming`,
      },
      accounts: {
        max_featured_tags: 10,
      },
      statuses: {
        max_characters: 500,
        max_media_attachments: 4,
        characters_reserved_per_url: 23,
      },
      media_attachments: {
        supported_mime_types: [
          'image/jpeg', 'image/png', 'image/gif', 'image/webp',
          'video/mp4', 'video/webm',
          'audio/mpeg', 'audio/ogg', 'audio/wav',
        ],
        image_size_limit: 16777216,
        image_matrix_limit: 33177600,
        video_size_limit: 103809024,
        video_frame_rate_limit: 120,
        video_matrix_limit: 8294400,
      },
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2629746,
      },
      translation: {
        enabled: false,
      },
      turnstile: {
        enabled: turnstile.enabled && !!turnstile.siteKey,
        site_key: turnstile.enabled ? turnstile.siteKey : '',
      },
    },
    registrations: {
      enabled: registrationMode !== 'none',
      approval_required: registrationMode === 'approval',
      message: null,
      url: null,
    },
    contact: {
      email: dbSettings.site_contact_email || `admin@${domain}`,
      account: null,
    },
    rules,
  });
});

export default app;
