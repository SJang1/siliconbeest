import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { resolveWebFinger, fetchRemoteActor } from '../../../../federation/webfinger';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

const app = new Hono<HonoEnv>();

app.get('/lookup', async (c) => {
  const acct = c.req.query('acct');
  const instanceDomain = c.env.INSTANCE_DOMAIN;

  if (!acct) {
    throw new AppError(400, 'Validation failed', 'acct is required');
  }

  // Parse acct: "user" (local) or "user@domain" (remote)
  const cleaned = acct.replace(/^@/, '');
  const parts = cleaned.split('@');
  const username = parts[0]!;
  const acctDomain = parts[1] || null;

  let row;
  if (!acctDomain || acctDomain === instanceDomain) {
    // Local account
    row = await c.env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL',
    ).bind(username).first();
  } else {
    // Remote account — check if we have it cached
    row = await c.env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain = ?2',
    ).bind(username, acctDomain).first();
  }

  // If remote account not in DB, try WebFinger resolve
  if (!row && acctDomain && acctDomain !== instanceDomain) {
    try {
      const wfResult = await resolveWebFinger(`${username}@${acctDomain}`, c.env.CACHE);
      if (wfResult?.actorUri) {
        const actorData = await fetchRemoteActor(wfResult.actorUri, c.env.CACHE, c.env.DB, instanceDomain);
        if (actorData) {
          // Upsert into accounts
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const preferredUsername = actorData.preferredUsername || username;
          await c.env.DB.prepare(
            `INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url,
             avatar_url, header_url, locked, bot, discoverable, inbox_url, shared_inbox_url,
             followers_count, following_count, statuses_count, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18)`,
          ).bind(
            id, preferredUsername, acctDomain,
            actorData.name || '', actorData.summary || '',
            actorData.id || wfResult.actorUri,
            actorData.url || `https://${acctDomain}/@${preferredUsername}`,
            actorData.icon?.url || '', actorData.image?.url || '',
            actorData.manuallyApprovesFollowers ? 1 : 0,
            actorData.type === 'Service' ? 1 : 0,
            actorData.discoverable ? 1 : 0,
            actorData.inbox || '', actorData.endpoints?.sharedInbox || '',
            0, 0, 0, now,
          ).run();

          row = await c.env.DB.prepare(
            'SELECT * FROM accounts WHERE username = ?1 AND domain = ?2',
          ).bind(preferredUsername, acctDomain).first();
        }
      }
    } catch (e) {
      console.error(`[lookup] WebFinger resolve failed for ${username}@${acctDomain}:`, e);
    }
  }

  if (!row) throw new AppError(404, 'Record not found');
  const domain = row.domain as string | null;

  // Parse account emoji_tags and proxy URLs
  let emojis: Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> = [];
  const emojiTagsRaw = row.emoji_tags as string | null;
  if (emojiTagsRaw && domain) {
    try {
      const tags = JSON.parse(emojiTagsRaw) as Array<{ shortcode?: string; name?: string; url?: string; static_url?: string }>;
      emojis = tags.map((t) => {
        const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
        const rawUrl = t.url || '';
        const rawStatic = t.static_url || rawUrl;
        const proxyIt = (u: string) => {
          if (!u) return u;
          try {
            const p = new URL(u);
            if (p.hostname === instanceDomain) return u;
            return `https://${instanceDomain}/proxy?url=${encodeURIComponent(u)}`;
          } catch { return u; }
        };
        return { shortcode: sc, url: proxyIt(rawUrl), static_url: proxyIt(rawStatic), visible_in_picker: false };
      });
    } catch { /* ignore */ }
  }

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct: domain ? `${row.username}@${domain}` : (row.username as string),
    display_name: (row.display_name as string) || '',
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note: (row.note as string) || '',
    url: (row.url as string) || `https://${instanceDomain}/@${row.username}`,
    uri: row.uri as string,
    avatar: (row.avatar_url as string) || `https://${instanceDomain}/default-avatar.svg`,
    avatar_static: (row.avatar_static_url as string) || `https://${instanceDomain}/default-avatar.svg`,
    header: (row.header_url as string) || `https://${instanceDomain}/default-header.svg`,
    header_static: (row.header_static_url as string) || `https://${instanceDomain}/default-header.svg`,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis,
    fields: safeJsonParse(row.fields as string | null, []),
  });
});

export default app;
