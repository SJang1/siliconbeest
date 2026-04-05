import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { getTurnstileSettings } from '../../../utils/turnstile';
import { MASTODON_V2_VERSION } from '../../../version';
import { getSettings, getRules, getStats } from '../../../services/instance';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;

  // Read settings from DB first, fall back to env vars
  const dbSettings = await getSettings(c.env.DB, [
    'site_title', 'site_description', 'registration_mode', 'registration_message',
    'site_contact_email', 'site_contact_username', 'site_landing_markdown',
    'terms_of_service', 'privacy_policy',
  ]);

  // Turnstile settings (cached in KV)
  const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);

  const title = dbSettings.site_title || c.env.INSTANCE_TITLE || domain;
  const registrationMode = dbSettings.registration_mode || c.env.REGISTRATION_MODE || 'none';

  // Usage stats + rules (parallel)
  const [stats, ruleRows] = await Promise.all([
    getStats(c.env.DB),
    getRules(c.env.DB),
  ]);

  const rules = ruleRows.map((r) => ({
    id: r.id,
    text: r.text,
  }));

  return c.json({
    domain,
    title,
    version: MASTODON_V2_VERSION,
    source_url: 'https://github.com/SJang1/siliconbeest',
    description: dbSettings.site_description || `${title} is powered by SiliconBeest, a serverless Fediverse server.`,
    usage: {
      users: {
        active_month: stats.userCount,
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
      enabled: registrationMode !== 'none' && registrationMode !== 'closed',
      approval_required: registrationMode === 'approval',
      message: dbSettings.registration_message || null,
      url: null,
    },
    contact: {
      email: dbSettings.site_contact_email || `admin@${domain}`,
      account: null,
    },
    rules,
    site_landing_markdown: dbSettings.site_landing_markdown || '',
    terms_of_service: dbSettings.terms_of_service || '',
    privacy_policy: dbSettings.privacy_policy || '',
  });
});

export default app;
