import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables } from '../env';
import { resolveToken, type ResolvedToken } from '../services/auth';
import { sha256 } from '../utils/crypto';

type MiddlewareEnv = { Bindings: Env; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
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
  c.set('tokenScopes', null);
  c.set('tokenId', null);

  const token = extractBearerToken(c.req.header('Authorization'));
  if (token) {
    const tokenHash = await sha256(token);
    const payload = await resolveToken(c.env.DB, c.env.CACHE, tokenHash, token);
    if (payload) {
      c.set('currentUser', payload.user);
      c.set('currentAccount', payload.account);
      c.set('tokenScopes', payload.scopes);
      c.set('tokenId', payload.tokenId);
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
  c.set('tokenScopes', null);
  c.set('tokenId', null);

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { error: 'The access token is invalid' },
      401,
    );
  }

  const tokenHash = await sha256(token);
  const payload = await resolveToken(c.env.DB, c.env.CACHE, tokenHash, token);
  if (!payload) {
    return c.json(
      { error: 'The access token is invalid' },
      401,
    );
  }

  c.set('currentUser', payload.user);
  c.set('currentAccount', payload.account);
  c.set('tokenScopes', payload.scopes);
  c.set('tokenId', payload.tokenId);

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
