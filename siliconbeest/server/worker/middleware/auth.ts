import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables } from '../env';

type MiddlewareEnv = { Bindings: Env; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of a string, used as a cache key for tokens.
 */
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

const CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

/**
 * Resolve a bearer token to user/account data.
 *
 * 1. Check KV cache (`token:{sha256}`)
 * 2. Fallback to D1 query on oauth_access_tokens JOIN users JOIN accounts
 * 3. On D1 hit, write result back to KV with 5-min TTL
 */
async function resolveToken(
  token: string,
  db: D1Database,
  cache: KVNamespace,
): Promise<TokenPayload | null> {
  const hash = await sha256(token);
  const cacheKey = `token:${hash}`;

  // 1. KV cache lookup
  const cached = await cache.get(cacheKey, 'json');
  if (cached) return cached as TokenPayload;

  // 2. D1 fallback
  const row = await db
    .prepare(
      `SELECT
         u.id   AS user_id,
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
  await cache.put(cacheKey, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return payload;
}

// ---------------------------------------------------------------------------
// Middleware exports
// ---------------------------------------------------------------------------

/**
 * Resolve the current user from a Bearer token (if present).
 * Always continues to the next handler regardless of result.
 */
export const authOptional = createMiddleware<MiddlewareEnv>(async (c, next) => {
  c.set('currentUser', null);
  c.set('currentAccount', null);

  const token = extractBearerToken(c.req.header('Authorization'));
  if (token) {
    const payload = await resolveToken(token, c.env.DB, c.env.CACHE);
    if (payload) {
      c.set('currentUser', payload.user);
      c.set('currentAccount', payload.account);
    }
  }

  await next();
});

/**
 * Require a valid Bearer token. Returns 401 if missing or invalid.
 */
export const authRequired = createMiddleware<MiddlewareEnv>(async (c, next) => {
  c.set('currentUser', null);
  c.set('currentAccount', null);

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { error: 'The access token is invalid' },
      401,
    );
  }

  const payload = await resolveToken(token, c.env.DB, c.env.CACHE);
  if (!payload) {
    return c.json(
      { error: 'The access token is invalid' },
      401,
    );
  }

  c.set('currentUser', payload.user);
  c.set('currentAccount', payload.account);

  await next();
});

/**
 * Require the current user to have the `admin` or `moderator` role.
 * Must be used *after* `authRequired`.
 */
export const adminRequired = createMiddleware<MiddlewareEnv>(async (c, next) => {
  const user = c.get('currentUser');
  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    return c.json(
      { error: 'This action is not allowed' },
      403,
    );
  }

  await next();
});

/**
 * Require the current user to have the `admin` role (not moderator).
 * For settings, domain blocks, etc. that only admins should access.
 */
export const adminOnlyRequired = createMiddleware<MiddlewareEnv>(async (c, next) => {
  const user = c.get('currentUser');
  if (!user || user.role !== 'admin') {
    return c.json(
      { error: 'This action is not allowed' },
      403,
    );
  }

  await next();
});
