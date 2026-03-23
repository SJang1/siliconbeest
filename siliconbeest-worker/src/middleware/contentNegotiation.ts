import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables } from '../env';

type MiddlewareEnv = { Bindings: Env; Variables: AppVariables };

const AP_CONTENT_TYPES = [
  'application/activity+json',
  'application/ld+json',
];

const AP_PROFILE = 'https://www.w3.org/ns/activitystreams';

/**
 * Detect whether the client is requesting an ActivityPub response.
 *
 * Sets `c.get('isActivityPub')` to `true` when the Accept header contains:
 * - `application/activity+json`
 * - `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`
 */
export const contentNegotiation = createMiddleware<MiddlewareEnv>(
  async (c, next) => {
    const accept = c.req.header('Accept') ?? '';

    const isAP =
      AP_CONTENT_TYPES.some((ct) => accept.includes(ct)) ||
      (accept.includes('application/ld+json') && accept.includes(AP_PROFILE));

    c.set('isActivityPub', isAP);

    await next();
  },
);
