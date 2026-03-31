import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables } from '../env';

type MiddlewareEnv = { Bindings: Env; Variables: AppVariables };

/**
 * Mastodon-compatible scope hierarchy:
 * - "read" grants read:accounts, read:statuses, etc.
 * - "write" grants write:statuses, write:accounts, etc.
 * - "follow" grants read:follows, write:follows, read:blocks, write:blocks,
 *   read:mutes, write:mutes (legacy Mastodon scope)
 * - "push" grants push
 */
function hasScope(grantedScopes: string, requiredScope: string): boolean {
  const granted = grantedScopes.split(/\s+/);

  // Direct match
  if (granted.includes(requiredScope)) return true;

  // Hierarchical match: "read" covers "read:*", "write" covers "write:*"
  const [category] = requiredScope.split(':');
  if (granted.includes(category)) return true;

  // Legacy "follow" scope covers follow-related sub-scopes
  if (granted.includes('follow')) {
    const followScopes = [
      'read:follows', 'write:follows',
      'read:blocks', 'write:blocks',
      'read:mutes', 'write:mutes',
    ];
    if (followScopes.includes(requiredScope)) return true;
  }

  // "admin" top-level covers admin:read and admin:write
  if (granted.includes('admin')) {
    if (requiredScope.startsWith('admin:')) return true;
  }

  return false;
}

/**
 * Middleware factory that requires a specific OAuth scope.
 * Must be used after authRequired or authOptional.
 *
 * Usage: app.post('/statuses', authRequired, requireScope('write:statuses'), handler)
 */
export function requireScope(scope: string) {
  return createMiddleware<MiddlewareEnv>(async (c, next) => {
    const tokenScopes = c.get('tokenScopes');

    // If no scopes set (e.g. no token, authOptional path), allow through
    // — the endpoint's own auth logic handles unauthenticated access.
    if (!tokenScopes) {
      await next();
      return;
    }

    if (!hasScope(tokenScopes, scope)) {
      return c.json(
        {
          error: 'This action is outside the authorized scopes',
          required_scope: scope,
        },
        403,
      );
    }

    await next();
  });
}
