import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * GET /api/v1/instance — Mastodon v1 instance info
 * Required by most third-party Mastodon clients (Ivory, Ice Cubes, Megalodon, etc.)
 */
app.get('/', async (c) => {
  const domain = c.env.INSTANCE_DOMAIN;

  const dbSettings: Record<string, string> = {};
  const { results: settingsRows } = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('site_title', 'site_description', 'registration_mode', 'site_contact_email', 'site_contact_username')",
  ).all();
  for (const row of settingsRows ?? []) {
    dbSettings[row.key as string] = row.value as string;
  }

  const title = dbSettings.site_title || c.env.INSTANCE_TITLE || domain;
  const description = dbSettings.site_description || `${title} is powered by SiliconBeest, a serverless Fediverse server.`;
  const registrationMode = dbSettings.registration_mode || c.env.REGISTRATION_MODE || 'none';

  const userCount = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL AND suspended_at IS NULL',
  ).first<{ cnt: number }>();

  const statusCount = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM statuses WHERE local = 1 AND deleted_at IS NULL',
  ).first<{ cnt: number }>();

  const domainCount = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL',
  ).first<{ cnt: number }>();

  // Rules
  const { results: ruleRows } = await c.env.DB.prepare(
    'SELECT id, text FROM rules ORDER BY priority ASC',
  ).all();
  const rules = (ruleRows ?? []).map((r: any) => ({ id: r.id, text: r.text }));

  // Contact account (admin)
  let contactAccount = null;
  const contactUsername = dbSettings.site_contact_username || 'admin';
  const adminRow = await c.env.DB.prepare(
    'SELECT a.* FROM accounts a JOIN users u ON u.account_id = a.id WHERE a.username = ?1 AND a.domain IS NULL AND u.role = ?2 LIMIT 1',
  ).bind(contactUsername, 'admin').first();

  if (adminRow) {
    contactAccount = {
      id: adminRow.id as string,
      username: adminRow.username as string,
      acct: adminRow.username as string,
      display_name: (adminRow.display_name as string) || '',
      note: (adminRow.note as string) || '',
      url: `https://${domain}/@${adminRow.username}`,
      uri: `https://${domain}/users/${adminRow.username}`,
      avatar: (adminRow.avatar_url as string) || null,
      avatar_static: (adminRow.avatar_static_url as string) || null,
      header: (adminRow.header_url as string) || null,
      header_static: (adminRow.header_static_url as string) || null,
      locked: !!(adminRow.locked as number),
      bot: !!(adminRow.bot as number),
      discoverable: !!(adminRow.discoverable as number),
      group: false,
      created_at: adminRow.created_at as string,
      last_status_at: adminRow.last_status_at as string | null,
      statuses_count: (adminRow.statuses_count as number) || 0,
      followers_count: (adminRow.followers_count as number) || 0,
      following_count: (adminRow.following_count as number) || 0,
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
    version: '4.0.0 (compatible; SiliconBeest 0.1.0)',
    urls: {
      streaming_api: `wss://${domain}/api/v1/streaming`,
    },
    stats: {
      user_count: userCount?.cnt ?? 0,
      status_count: statusCount?.cnt ?? 0,
      domain_count: domainCount?.cnt ?? 0,
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
  });
});

export default app;
