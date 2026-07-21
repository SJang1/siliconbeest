/* oxlint-disable fp/no-promise-reject -- rethrow after logging so errorHandler still runs */
import { createMiddleware } from 'hono/factory';
import type { AppVariables } from '../types';
import {
  debugLog,
  headersToObject,
  isDebugEnabled,
  parseBodyForDebugLog,
  readLimitedBody,
} from '../../../../packages/shared/utils/debugLog';
import { ensureFedifyDebugLogging } from '../utils/debugLogtape';
import { ensureDebugSentryLogging } from '../utils/debugSentry';

type MiddlewareEnv = { Variables: AppVariables };

// Body types that are safe and useful to read for logging. Streaming
// responses (SSE, media, websockets) must never be buffered here.
function isLoggableBodyType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/event-stream')) return false;
  return type.includes('json')
    || type.includes('application/x-www-form-urlencoded')
    || type.includes('xml');
}

async function readBodyForDebug(
  source: Request | Response,
  contentType: string | null | undefined,
): Promise<unknown> {
  if (!isLoggableBodyType(contentType)) return undefined;
  try {
    // Capped stream read — never buffers an oversized payload in memory.
    const text = await readLimitedBody(source.clone().body);
    if (text.length === 0) return undefined;
    return parseBodyForDebugLog(text, contentType);
  } catch (err) {
    return `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

/**
 * When `DEBUG` is enabled, log every request and response in full detail:
 * method, path, headers, parsed bodies, the authenticated user, the
 * response status, and duration. Ultra-sensitive values (Authorization,
 * cookies, passwords, private keys) are redacted by `debugLog` itself.
 */
export const debugLogMiddleware = createMiddleware<MiddlewareEnv>(
  async (c, next) => {
    if (!isDebugEnabled()) {
      await next();
      return;
    }

    await ensureFedifyDebugLogging();
    ensureDebugSentryLogging();

    const started = performance.now();
    const requestId = c.get('requestId');
    const requestBody = await readBodyForDebug(c.req.raw, c.req.header('Content-Type'));

    debugLog('http', `--> ${c.req.method} ${c.req.path}`, {
      requestId,
      url: c.req.url,
      headers: headersToObject(c.req.raw.headers),
      body: requestBody,
    });

    try {
      await next();
    } catch (err) {
      debugLog('http', `x-- ${c.req.method} ${c.req.path} threw`, {
        requestId,
        durationMs: Math.round(performance.now() - started),
        user: c.get('currentUser'),
        account: c.get('currentAccount'),
        error: err,
      });
      throw err;
    }

    const user = c.get('currentUser');
    const account = c.get('currentAccount');
    const responseBody = await readBodyForDebug(c.res, c.res.headers.get('Content-Type'));

    debugLog('http', `<-- ${c.req.method} ${c.req.path} ${c.res.status}`, {
      requestId,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      user: user
        ? { id: user.id, accountId: user.account_id, role: user.role }
        : null,
      account: account
        ? { id: account.id, username: account.username, domain: account.domain }
        : null,
      tokenScopes: c.get('tokenScopes'),
      responseHeaders: headersToObject(c.res.headers),
      body: responseBody,
    });
  },
);
