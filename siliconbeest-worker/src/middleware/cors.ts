import { cors } from 'hono/cors';

/**
 * CORS middleware configured for Mastodon API compatibility.
 *
 * - All origins are allowed so third-party Mastodon clients can connect.
 * - Preflight OPTIONS requests are handled automatically.
 * - Common Mastodon headers are allowed / exposed.
 */
export const corsMiddleware = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  exposeHeaders: ['Link', 'X-Request-Id'],
  maxAge: 86400, // 24 hours
});
