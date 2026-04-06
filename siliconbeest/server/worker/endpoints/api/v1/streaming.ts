/**
 * GET /api/v1/streaming — WebSocket upgrade endpoint for Mastodon Streaming API
 *
 * Authenticates the user via Bearer token (header or query param), then
 * forwards the WebSocket upgrade to the user's StreamingDO instance.
 *
 * Query params:
 *   stream — user | user:notification | public | public:local | hashtag | list | direct
 *   tag    — hashtag name (when stream=hashtag)
 *   list   — list id (when stream=list)
 *   access_token — alternative to Authorization header (common for WS clients)
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';

const CACHE_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Helpers (inlined because WS upgrade cannot use Hono middleware)
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface TokenPayload {
  user: { id: string; account_id: string; email: string; role: string };
  account: { id: string; username: string; domain: string | null };
}

async function resolveToken(
  token: string,
): Promise<TokenPayload | null> {
  const hash = await sha256(token);
  const cacheKey = `token:${hash}`;

  // 1. KV cache lookup
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached as TokenPayload;

  // 2. D1 fallback
  const row = await env.DB
    .prepare(
      `SELECT
         u.id       AS user_id,
         u.email,
         u.role,
         a.id       AS account_id,
         a.username,
         a.domain
       FROM oauth_access_tokens t
       JOIN users    u ON u.id = t.user_id
       JOIN accounts a ON a.id = u.account_id
       WHERE t.token = ?1
         AND (t.revoked_at IS NULL)
       LIMIT 1`,
    )
    .bind(token)
    .first();

  if (!row) return null;

  const payload: TokenPayload = {
    user: {
      id: row.user_id as string,
      account_id: row.account_id as string,
      email: row.email as string,
      role: row.role as string,
    },
    account: {
      id: row.account_id as string,
      username: row.username as string,
      domain: (row.domain as string) ?? null,
    },
  };

  // 3. Populate cache
  await env.CACHE.put(cacheKey, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return payload;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', async (c) => {
  // 1. Require WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  // 2. Extract token from Authorization header or access_token query param
  const authHeader = c.req.header('Authorization');
  const token =
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ||
    c.req.query('access_token') ||
    null;

  if (!token) {
    return c.json({ error: 'The access token is invalid' }, 401);
  }

  // 3. Resolve token to user
  const payload = await resolveToken(token);
  if (!payload) {
    return c.json({ error: 'The access token is invalid' }, 401);
  }

  const userId = payload.user.id;
  const stream = c.req.query('stream') || 'user';

  // 4. Forward upgrade to the appropriate StreamingDO instance
  //    Public streams use a shared DO, user streams use per-user DOs
  const doName = (stream === 'public' || stream === 'public:local')
    ? '__public__'
    : userId;
  const doId = env.STREAMING_DO.idFromName(doName);
  const doStub = env.STREAMING_DO.get(doId);

  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/';
  doUrl.searchParams.set('stream', stream);

  // Carry tag / list params through so DO can use them later
  const tag = c.req.query('tag');
  if (tag) doUrl.searchParams.set('tag', tag);

  const list = c.req.query('list');
  if (list) doUrl.searchParams.set('list', list);

  return doStub.fetch(
    new Request(doUrl.toString(), {
      headers: c.req.raw.headers,
    }),
  );
});

export default app;
