import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { getAccountByUsername } from '../../../../services/account';
import { assertAccountViewable } from '../../../../services/permissions';
import { debugLog } from '../../../../../../../packages/shared/utils/debugLog';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import { sanitizeHtml } from '../../../../utils/sanitize';

type HonoEnv = { Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  return JSON.parse(val);
}

const app = new Hono<HonoEnv>();

app.get('/lookup', async (c) => {
  const acct = c.req.query('acct');
  const instanceDomain = env.INSTANCE_DOMAIN;

  if (!acct) {
    throw new AppError(400, 'Validation failed', 'acct is required');
  }

  // Parse acct: "user" (local) or "user@domain" (remote)
  const cleaned = acct.replace(/^@/, '');
  const atPosition = cleaned.lastIndexOf('@');
  const username = atPosition === -1 ? cleaned : cleaned.slice(0, atPosition);
  // Domains are DNS names (case-insensitive): normalize to lowercase so the
  // instance-domain check and cached-account lookup use the canonical form.
  // The username intentionally keeps its exact case (AP identity).
  const acctDomain = atPosition === -1
    ? null
    : cleaned.slice(atPosition + 1).toLowerCase() || null;
  if (!username) throw new AppError(400, 'Validation failed', 'acct is invalid');

  const row = !acctDomain || acctDomain === instanceDomain.toLowerCase()
    ? await getAccountByUsername(username)
    : await getAccountByUsername(username, acctDomain);

  debugLog('account.lookup', `acct lookup ${cleaned}`, {
    acct,
    username,
    domain: acctDomain,
    found: !!row,
    accountId: row ? (row.id as string) : null,
  });

  // Lookup is an exact read of locally known accounts. Network discovery is
  // deliberately confined to the authenticated search `resolve` path, where
  // OAuth scope, blocked-domain, and fetched-identity policies are enforced.

  if (!row) throw new AppError(404, 'Record not found');
  await assertAccountViewable(row.id as string);
  const domain = row.domain as string | null;

  const emojis = parseCustomEmojiTagsJson(row.emoji_tags as string | null, instanceDomain);
  const displayName = sanitizeHtml((row.display_name as string) || '');
  const note = sanitizeHtml((row.note as string) || '');

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct: domain ? `${row.username}@${domain}` : (row.username as string),
    display_name: displayName,
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note,
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
    ...(row.silenced_at ? { limited: true } : {}),
    ...(row.memorial ? { memorial: true } : {}),
    emojis,
    fields: safeJsonParse(row.fields as string | null, []),
  });
});

export default app;
