import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables } from '../env';

type MiddlewareEnv = { Bindings: Env; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type RateLimitOptions = {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /**
   * Optional key prefix to distinguish endpoints.
   * Defaults to the request pathname.
   */
  keyPrefix?: string;
};

// Convenient presets ---
export const RATE_LIMIT_GENERAL: RateLimitOptions = {
  maxRequests: 300,
  windowMs: 5 * 60 * 1000, // 5 minutes
};

export const RATE_LIMIT_AUTH: RateLimitOptions = {
  maxRequests: 30,
  windowMs: 5 * 60 * 1000,
  keyPrefix: 'auth',
};

export const RATE_LIMIT_REGISTRATION: RateLimitOptions = {
  maxRequests: 5,
  windowMs: 5 * 60 * 1000,
  keyPrefix: 'reg',
};

export const RATE_LIMIT_ADMIN: RateLimitOptions = {
  maxRequests: 60,
  windowMs: 5 * 60 * 1000,
  keyPrefix: 'admin',
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * KV-based sliding-window rate limiter.
 *
 * Key format: `rl:{ip}:{endpoint}:{windowId}`
 *
 * Each window is identified by `floor(now / windowMs)` so that the counter
 * resets naturally. KV expiration is set to `2 * windowMs` so stale keys are
 * garbage-collected automatically.
 *
 * Usage:
 * ```ts
 * app.use('/api/v1/accounts', createRateLimit(RATE_LIMIT_REGISTRATION));
 * ```
 */
export function createRateLimit(opts: RateLimitOptions) {
  const { maxRequests, windowMs } = opts;

  return createMiddleware<MiddlewareEnv>(async (c, next) => {
    const ip =
      c.req.header('CF-Connecting-IP') ??
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
      '0.0.0.0';

    const endpoint = opts.keyPrefix ?? new URL(c.req.url).pathname;
    const windowId = Math.floor(Date.now() / windowMs);
    const key = `rl:${ip}:${endpoint}:${windowId}`;

    const kv = c.env.CACHE;

    // Read current count
    const current = parseInt((await kv.get(key)) ?? '0', 10);

    if (current >= maxRequests) {
      const windowEnd = (windowId + 1) * windowMs;
      const retryAfter = Math.ceil((windowEnd - Date.now()) / 1000);

      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Increment and store (TTL = 2 windows to cover edge cases)
    await kv.put(key, String(current + 1), {
      expirationTtl: Math.ceil((windowMs * 2) / 1000),
    });

    // Attach informational headers
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(maxRequests - current - 1));

    await next();
  });
}
