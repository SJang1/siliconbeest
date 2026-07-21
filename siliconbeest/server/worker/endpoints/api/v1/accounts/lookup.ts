import { Hono } from 'hono';
import type { Context } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import type { AccountRow } from '../../../../types/db';
import { AppError } from '../../../../middleware/errorHandler';
import { authOptional } from '../../../../middleware/auth';
import { getAccountById, getAccountByUsername } from '../../../../services/account';
import { assertAccountViewable, canResolveRemoteDomain } from '../../../../services/permissions';
import { resolveRemoteAccount } from '../../../../federation/resolveRemoteAccount';
import { getFedifyContext } from '../../../../federation/helpers/send';
import { debugLog } from '../../../../../../../packages/shared/utils/debugLog';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import { sanitizeHtml } from '../../../../utils/sanitize';

type HonoEnv = { Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  return JSON.parse(val);
}

const app = new Hono<HonoEnv>();

/**
 * Resolve a remote acct that is not cached locally: WebFinger discovery
 * followed by the shared policy-checked actor fetch. Returns the stored
 * row, or null when discovery fails or policy denies the domain.
 */
async function resolveUncachedRemoteAccount(
  c: Context<HonoEnv>,
  username: string,
  acctDomain: string,
): Promise<AccountRow | null> {
  const currentAccountId = c.get('currentAccount')?.id ?? null;
  if (!await canResolveRemoteDomain(currentAccountId, acctDomain)) return null;

  const ctx = getFedifyContext(c.get('federation'));
  const acct = `${username}@${acctDomain}`;
  let wfResult: Awaited<ReturnType<typeof ctx.lookupWebFinger>> = null;
  try {
    wfResult = await ctx.lookupWebFinger(`acct:${acct}`);
  } catch (e) {
    console.warn(`[lookup] WebFinger failed for acct:${acct}:`, e);
  }
  const selfLink = wfResult?.links?.find(
    (link) =>
      link.rel === 'self'
      && (link.type === 'application/activity+json'
        || link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"')
      && link.href,
  );
  const actorUri = selfLink?.href;
  debugLog('account.lookup.remote', `webfinger acct:${acct}`, {
    acct,
    webfinger: wfResult,
    actorUri: actorUri ?? null,
  });
  if (!actorUri) return null;

  // The advertised actor may live on a different host than the acct domain;
  // that host must pass the same resolution policy.
  let actorHost: string;
  try {
    actorHost = new URL(actorUri).hostname;
  } catch {
    return null;
  }
  if (actorHost.toLowerCase() !== acctDomain
    && !await canResolveRemoteDomain(currentAccountId, actorHost)) {
    return null;
  }

  const accountId = await resolveRemoteAccount(actorUri, currentAccountId);
  if (!accountId) return null;
  return await getAccountById(accountId);
}

app.get('/lookup', authOptional, async (c) => {
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

  const isRemote = !!acctDomain && acctDomain !== instanceDomain.toLowerCase();
  let row = isRemote
    ? await getAccountByUsername(username, acctDomain)
    : await getAccountByUsername(username);

  debugLog('account.lookup', `acct lookup ${cleaned}`, {
    acct,
    username,
    domain: acctDomain,
    found: !!row,
    accountId: row ? (row.id as string) : null,
  });

  // Unknown remote accts fall through to network discovery (WebFinger →
  // actor fetch) behind the same blocked-domain and fetched-identity
  // policies as the search `resolve` path.
  let resolvedNow = false;
  if (!row && isRemote && acctDomain) {
    row = await resolveUncachedRemoteAccount(c, username, acctDomain);
    resolvedNow = !!row;
  }

  if (!row) throw new AppError(404, 'Record not found');
  await assertAccountViewable(row.id as string);
  const domain = row.domain as string | null;

  // Background refresh for stale remote accounts (2h), mirroring GET /:id.
  // Skipped when the row was just resolved: resolveRemoteAccount already
  // enqueued a full fetch for it.
  if (!resolvedNow && domain && row.uri) {
    const fetchedAt = row.fetched_at as string | null;
    const staleMs = 2 * 60 * 60 * 1000; // 2 hours
    const isStale = !fetchedAt || (Date.now() - new Date(fetchedAt).getTime() > staleMs);
    if (isStale) {
      try {
        await env.QUEUE_INTERNAL.send({
          type: 'fetch_remote_account',
          actorUri: row.uri as string,
          forceRefresh: true,
        });
      } catch { /* non-blocking */ }
    }
  }

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
