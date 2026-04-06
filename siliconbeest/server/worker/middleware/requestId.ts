import { createMiddleware } from 'hono/factory';
import type { AppVariables } from '../types';

type MiddlewareEnv = { Variables: AppVariables };

/**
 * Generate a unique request ID (UUIDv4) for every incoming request.
 *
 * - Sets the `requestId` context variable for logging / tracing.
 * - Adds an `X-Request-Id` response header.
 */
export const requestIdMiddleware = createMiddleware<MiddlewareEnv>(
  async (c, next) => {
    const id = crypto.randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  },
);
