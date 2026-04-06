import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { getVapidPublicKey } from '../../../utils/vapid';
import { MASTODON_V1_VERSION } from '../../../version';
import { getSettings, getInstanceTitle, getRules, getStats, getContactAccount } from '../../../services/instance';

const app = new Hono<{ Variables: AppVariables }>();

/**
 * GET /api/v1/instance — Mastodon v1 instance info
 * Required by most third-party Mastodon clients (Ivory, Ice Cubes, Megalodon, etc.)
 */
app.get('/', async (c) => {
  const domain = env.INSTANCE_DOMAIN;

  const dbSettings = await getSettings([
    'site_description', 'registration_mode', 'registration_message',
    'site_contact_email', 'site_contact_username', 'web_push_enabled',
  ]);

  const title = await getInstanceTitle();
  const description = dbSettings.site_description || `${title} is powered by SiliconBeest, a serverless Fediverse server.`;
  const registrationMode = dbSettings.registration_mode || env.REGISTRATION_MODE || 'none';

  // Stats + rules (parallel)
  const [stats, ruleRows] = await Promise.all([
    getStats(),
    getRules(),
  ]);
  const rules = ruleRows.map((r) => ({ id: r.id, text: r.text }));

  // Contact account (admin)
  let contactAccount = null;
  const contactUsername = dbSettings.site_contact_username || 'admin';
  const adminRow = await getContactAccount(contactUsername);

  if (adminRow) {
    contactAccount = {
      id: adminRow.id,
      username: adminRow.username,
      acct: adminRow.username,
      display_name: adminRow.display_name || '',
      note: adminRow.note || '',
      url: `https://${domain}/@${adminRow.username}`,
      uri: `https://${domain}/users/${adminRow.username}`,
      avatar: adminRow.avatar_url || null,
      avatar_static: adminRow.avatar_static_url || null,
      header: adminRow.header_url || null,
      header_static: adminRow.header_static_url || null,
      locked: !!adminRow.locked,
      bot: !!adminRow.bot,
      discoverable: !!adminRow.discoverable,
      group: false,
      created_at: adminRow.created_at,
      last_status_at: adminRow.last_status_at,
      statuses_count: adminRow.statuses_count || 0,
      followers_count: adminRow.followers_count || 0,
      following_count: adminRow.following_count || 0,
      emojis: [],
      fields: [],
    };
  }

  return c.json({
    uri: domain,
    title,
    short_description: description,
    description,
    email: dbSettings.site_contact_email || `admin@${domain}`,
    version: MASTODON_V1_VERSION,
    urls: {
      streaming_api: `wss://${domain}/api/v1/streaming`,
    },
    stats: {
      user_count: stats.userCount,
      status_count: stats.statusCount,
      domain_count: stats.domainCount,
    },
    thumbnail: `https://${domain}/thumbnail.png`,
    languages: ['en'],
    registrations: registrationMode !== 'none' && registrationMode !== 'closed',
    approval_required: registrationMode === 'approval',
    invites_enabled: false,
    configuration: {
      accounts: { max_featured_tags: 10 },
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
    },
    contact_account: contactAccount,
    rules,
    push_enabled: dbSettings.web_push_enabled === '1',
    vapid_key: (await getVapidPublicKey()) || null,
  });
});

export default app;
