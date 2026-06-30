import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { getTurnstileSettings } from '../../../utils/turnstile';
import { MASTODON_V2_VERSION } from '../../../version';
import { getSettings, getInstanceTitle, getRules, getStats } from '../../../services/instance';
import { getRepositoryUrl } from '../../../utils/repository';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', async (c) => {
  const domain = env.INSTANCE_DOMAIN;

  // Read settings from DB first, fall back to env vars
  const dbSettings = await getSettings([
    'site_description', 'registration_mode', 'registration_message',
    'site_contact_email', 'site_contact_username', 'site_landing_markdown',
    'terms_of_service', 'privacy_policy',
  ]).catch((): Record<string, string> => ({}));

  // Turnstile settings (cached in KV)
  const turnstile = await getTurnstileSettings().catch(() => ({ enabled: false, siteKey: '', secretKey: '' }));

  const title = await getInstanceTitle().catch(() => env.INSTANCE_TITLE);
  const registrationMode = dbSettings.registration_mode || env.REGISTRATION_MODE;

  // Usage stats + rules (parallel)
  const [stats, ruleRows] = await Promise.all([
    getStats().catch(() => ({ userCount: 0, statusCount: 0, domainCount: 0 })),
    getRules().catch(() => []),
  ]);

  const rules = ruleRows.map((r) => ({
    id: r.id,
    text: r.text,
  }));

  return c.json({
    domain,
    title,
    version: MASTODON_V2_VERSION,
    source_url: getRepositoryUrl(),
    description: dbSettings.site_description,
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
      enabled: registrationMode === 'open' || registrationMode === 'approval',
      approval_required: registrationMode === 'approval',
      message: dbSettings.registration_message || null,
      url: null,
    },
    contact: {
      email: dbSettings.site_contact_email || null,
      account: null,
    },
    rules,
    site_landing_markdown: dbSettings.site_landing_markdown || '',
    terms_of_service: dbSettings.terms_of_service || '',
    privacy_policy: dbSettings.privacy_policy || '',
  });
});

export default app;
