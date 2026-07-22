/**
 * GET /api/v1/streaming — WebSocket upgrade endpoint for Mastodon Streaming API
 *
 * Authenticates the user via Bearer token, auth cookie, or query param, then
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
import { resolveToken } from '../../../services/auth';
import { sha256 } from '../../../utils/crypto';
import { getAuthTokenFromCookie } from '../../../utils/authCookie';
import {
  canAccessStreamingChannel,
  parseStreamingChannel,
  permittedStreamingChannels,
} from '../../../../../../packages/shared/permissions';
import {
  resolveStreamingTopology,
  stableStreamingLeaf,
} from '../../../../../../packages/shared/utils/streamingTopology';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const app = new Hono<{ Variables: AppVariables }>();

function debugStreaming(message: string, data?: Record<string, unknown>) {
  console.info(`[streaming endpoint] ${message}`, data ?? {});
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1] ?? null;
}

async function resolveFirstValidToken(tokens: Array<string | null | undefined>) {
  for (const token of tokens) {
    if (!token) continue;
    const tokenHash = await sha256(token);
    const payload = await resolveToken(tokenHash, token);
    if (payload) return payload;
  }
  return null;
}

app.get('/', async (c) => {
  const requestedStream = c.req.query('stream') || 'user';

  // 1. Require WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  debugStreaming('request', {
    stream: requestedStream,
    upgrade: upgradeHeader ?? null,
    hasBearer: !!extractBearerToken(c.req.header('Authorization')),
    hasCookie: !!getAuthTokenFromCookie(c.req.header('Cookie')),
    hasQueryToken: !!c.req.query('access_token'),
  });

  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    debugStreaming('rejected: missing websocket upgrade', { stream: requestedStream });
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  // 2. Resolve token to user. Browser WebSocket clients cannot set an
  // Authorization header, so same-origin cookie auth must work here too.
  const payload = await resolveFirstValidToken([
    extractBearerToken(c.req.header('Authorization')),
    getAuthTokenFromCookie(c.req.header('Cookie')),
    c.req.query('access_token'),
  ]);
  if (!payload) {
    debugStreaming('rejected: invalid token', { stream: requestedStream });
    return c.json({ error: 'The access token is invalid' }, 401);
  }

  const stream = parseStreamingChannel(requestedStream);
  if (!stream) {
    return c.json({ error: 'Unknown channel requested' }, 400);
  }
  if (!canAccessStreamingChannel(payload.scopes, stream)) {
    return c.json({ error: 'This action is outside the authorized scopes' }, 403);
  }

  if (stream === 'list') {
    const listId = c.req.query('list');
    if (!listId) return c.json({ error: 'list is required' }, 422);
    const ownedList = await env.DB_META_C000.prepare(
      'SELECT id FROM lists WHERE id = ?1 AND account_id = ?2 LIMIT 1',
    ).bind(listId, payload.account.id).first<{ id: string }>();
    if (!ownedList) return c.json({ error: 'Record not found' }, 404);
  }
  if ((stream === 'hashtag' || stream === 'hashtag:local') && !c.req.query('tag')) {
    return c.json({ error: 'tag is required' }, 422);
  }

  const userId = payload.user.id;

  // 4. Forward upgrade to the appropriate StreamingDO instance
  //    Public streams use a shared DO, user streams use per-user DOs
  const topology = resolveStreamingTopology(env);
  const publicStream = stream === 'public' || stream === 'public:local';
  const preferredPublicLeaf = stableStreamingLeaf(userId, topology.leafCount);
  const doNames = publicStream
    ? Array.from(
        { length: Math.min(3, topology.leafCount) },
        (_, offset) => `public:leaf:${(preferredPublicLeaf + offset) % topology.leafCount}`,
      )
    : [userId];

  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/';
  doUrl.searchParams.set('stream', stream);

  // Carry tag / list params through so DO can use them later
  const tag = c.req.query('tag');
  if (tag) doUrl.searchParams.set('tag', tag);

  const list = c.req.query('list');
  if (list) doUrl.searchParams.set('list', list);

  debugStreaming('forwarding to durable object', {
    stream,
    target: publicStream ? doNames[0] : 'user',
  });

  let response: Response | null = null;
  try {
    const forwardHeaders = new Headers(c.req.raw.headers);
    const allowedStreams = permittedStreamingChannels(payload.scopes)
      .filter((channel) => channel !== 'list' || stream === 'list');
    forwardHeaders.set('X-Siliconbeest-Allowed-Streams', JSON.stringify(allowedStreams));
    forwardHeaders.set(
      'X-Siliconbeest-Socket-Limit',
      String(publicStream ? topology.publicLeafMaxSockets : topology.userMaxSockets),
    );
    for (const doName of doNames) {
      const doStub = env.STREAMING_DO.getByName(doName);
      response = await doStub.fetch(doUrl.toString(), {
        method: c.req.method,
        headers: forwardHeaders,
      });
      if (response.status !== 503 || !publicStream) break;
      debugStreaming('public leaf full; trying spillover leaf', { stream, target: doName });
    }
    if (!response) throw new Error('No streaming Durable Object target was available');
    debugStreaming('durable object response', {
      stream,
      status: response.status,
      hasWebSocket: !!response.webSocket,
    });
  } catch (error) {
    debugStreaming('durable object fetch failed', {
      stream,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return response;
});

export default app;
