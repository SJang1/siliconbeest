/**
 * SiliconBeest Worker — Hono App Entry Point
 *
 * Mounts all route groups (Mastodon API, OAuth, ActivityPub, well-known)
 * with global middleware and exports the Cloudflare Workers fetch handler.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { federation } from '@fedify/hono';

import type { Env, AppVariables } from './env';
import { corsMiddleware } from './middleware/cors';
import { requestIdMiddleware } from './middleware/requestId';
import { contentNegotiation } from './middleware/contentNegotiation';
import { errorHandler } from './middleware/errorHandler';
import { createRateLimit, RATE_LIMIT_ADMIN } from './middleware/rateLimit';
import { createFed, setWaitUntil, type FedifyContextData } from './federation/fedify';
import { setupActorDispatcher } from './federation/dispatchers/actor';
import { setupNodeInfoDispatcher } from './federation/dispatchers/nodeinfo';
import { setupCollectionDispatchers } from './federation/dispatchers/collections';
import { setupObjectDispatchers, handleActivityRequest } from './federation/dispatchers/objects';
import { setupInboxListeners } from './federation/listeners/inbox';

// ---------------------------------------------------------------------------
// Fedify Federation — singleton per isolate
//
// Dispatchers and listeners are registered ONCE at module load and reused
// across all requests.  Only waitUntil and context data (env) change
// per-request.  This avoids the overhead of createFederation() + 5 setup
// calls on every single HTTP request.
// ---------------------------------------------------------------------------
let fedInitialized = false;

// -- Well-Known / Discovery --
import nodeinfo2_0 from './endpoints/wellknown/nodeinfo2_0';
import hostMeta from './endpoints/wellknown/hostMeta';

// -- OAuth --
import oauthAuthorize from './endpoints/oauth/authorize';
import oauthToken from './endpoints/oauth/token';
import oauthRevoke from './endpoints/oauth/revoke';

// -- Mastodon API v1 --
import apps from './endpoints/api/v1/apps';
import accounts from './endpoints/api/v1/accounts/index';
import timelines from './endpoints/api/v1/timelines/index';
import notifications from './endpoints/api/v1/notifications/index';
import favourites from './endpoints/api/v1/favourites';
import bookmarks from './endpoints/api/v1/bookmarks';
import blocks from './endpoints/api/v1/blocks';
import mutes from './endpoints/api/v1/mutes';
import preferences from './endpoints/api/v1/preferences';
import customEmojis from './endpoints/api/v1/customEmojis';
import markers from './endpoints/api/v1/markers';
import statuses from './endpoints/api/v1/statuses/index';
import streaming from './endpoints/api/v1/streaming';
import push from './endpoints/api/v1/push/index';
import reports from './endpoints/api/v1/reports';
import polls from './endpoints/api/v1/polls/index';
import conversations from './endpoints/api/v1/conversations/index';
import followRequests from './endpoints/api/v1/followRequests';
import lists from './endpoints/api/v1/lists/index';
import tags from './endpoints/api/v1/tags';
import suggestions from './endpoints/api/v1/suggestions';
import announcements from './endpoints/api/v1/announcements';
import rules from './endpoints/api/v1/rules';
import trends from './endpoints/api/v1/trends/index';
import csvExport from './endpoints/api/v1/export';
import csvImport from './endpoints/api/v1/import';
import followedTags from './endpoints/api/v1/followedTags';
import featuredTags from './endpoints/api/v1/featuredTags';
import directory from './endpoints/api/v1/directory';
import userDomainBlocks from './endpoints/api/v1/domainBlocks';
import endorsements from './endpoints/api/v1/endorsements';

// -- Auth --
import passwords from './endpoints/api/v1/auth/passwords';
import authLogin from './endpoints/api/v1/auth/login';
import authWebauthn from './endpoints/api/v1/auth/webauthn';
import resendConfirmation from './endpoints/api/v1/auth/resendConfirmation';
import emailConfirmPage from './endpoints/auth/confirm';

// -- Account extras --
import changePassword from './endpoints/api/v1/accounts/change_password';

// -- Instance v1 --
import instanceV1 from './endpoints/api/v1/instance';
import instancePeers from './endpoints/api/v1/instance/peers';
import instanceActivity from './endpoints/api/v1/instance/activity';

// -- Admin API --
import admin from './endpoints/api/v1/admin/index';

// -- Mastodon API v2 --
import instanceV2 from './endpoints/api/v2/instance';
import searchV2 from './endpoints/api/v2/search';
import mediaV2 from './endpoints/api/v2/media';
import filters from './endpoints/api/v1/filters/index';

// -- Media serving --
import mediaServe from './endpoints/media';

// -- Media proxy (remote Fediverse media cache) --
import proxyEndpoint from './endpoints/proxy';

// -- ActivityPub --
import apActor from './endpoints/activitypub/actor';
import apInstanceActor from './endpoints/activitypub/instanceActor';

// -- Durable Object export --
export { StreamingDO } from './durableObjects/streaming';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Global middleware (order matters)
// ---------------------------------------------------------------------------

app.onError(errorHandler);
app.use('*', requestIdMiddleware);
app.use('*', corsMiddleware);
app.use('*', contentNegotiation);
app.use('*', logger());

// Security headers
app.use('*', async (c, next) => {
  await next();
  // Strict CSP for API endpoints
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// ---------------------------------------------------------------------------
// Fedify Federation Middleware
//
// In Cloudflare Workers the env bindings are only available per-request,
// so we create a Federation instance and register dispatchers on every
// request.  The @fedify/hono `federation()` helper returns a Hono-compatible
// middleware; we invoke it inline.
//
// Fedify handles: /.well-known/webfinger, /.well-known/nodeinfo,
//   /nodeinfo/2.1, /users/{identifier} (actor AP + WebFinger)
// Hono handles (Fedify passes through): /.well-known/host-meta,
//   /nodeinfo/2.0, /actor, /inbox, /users/*/outbox, etc.
// ---------------------------------------------------------------------------

const FEDIFY_SKIP_PREFIXES: string[] = [
  // All Fedify-handled routes are active. Remaining routes fall through to Hono.
];

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Skip Fedify for paths our existing endpoints handle better
  for (const prefix of FEDIFY_SKIP_PREFIXES) {
    if (path.startsWith(prefix) || path === prefix) {
      return next();
    }
  }

  // Get or create the cached Federation instance (once per isolate)
  const fed = createFed(c.env);

  // Register dispatchers/listeners ONCE
  if (!fedInitialized) {
    setupActorDispatcher(fed);
    setupNodeInfoDispatcher(fed);
    setupCollectionDispatchers(fed);
    setupObjectDispatchers(fed);
    setupInboxListeners(fed);
    fedInitialized = true;
  }

  // Update per-request waitUntil so fire-and-forget enqueues survive
  setWaitUntil((p) => c.executionCtx.waitUntil(p));

  // Store federation instance for use in route handlers (sendActivity)
  c.set('federation', fed);

  const fedMiddleware = federation<FedifyContextData, typeof c>(
    fed,
    (_ctx) => ({ env: c.env }),
  );

  return fedMiddleware(c, next);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/healthz', (c) => c.text('ok'));

// ---------------------------------------------------------------------------
// Authorize Interaction (remote follow)
// ---------------------------------------------------------------------------

app.get('/authorize_interaction', (c) => {
  const uri = c.req.query('uri');
  if (!uri) {
    return c.json({ error: 'Missing uri parameter' }, 400);
  }

  // Parse the URI: could be @user@domain, acct:user@domain, or a full URL
  let acct = uri;

  // Strip leading @ if present
  if (acct.startsWith('@')) acct = acct.slice(1);
  // Strip acct: prefix
  if (acct.startsWith('acct:')) acct = acct.slice(5);

  // Try parsing as a full URL first (e.g. https://ani.work/@dazeemdas)
  try {
    const url = new URL(acct);
    const match = url.pathname.match(/^\/@?([a-zA-Z0-9_.-]+)/);
    if (match) {
      // Extract username from path and build user@domain
      acct = `${match[1]}@${url.hostname}`;
    } else {
      return c.redirect(`https://${c.env.INSTANCE_DOMAIN}${url.pathname}`, 302);
    }
  } catch {
    // Not a URL, continue with acct as-is
  }

  // If it looks like user@domain, redirect to /@user@domain profile page
  if (acct.includes('@')) {
    const atAcct = acct.startsWith('@') ? acct : `@${acct}`;
    return c.redirect(`https://${c.env.INSTANCE_DOMAIN}/${atAcct}`, 302);
  }

  // Fallback to search
  return c.redirect(`https://${c.env.INSTANCE_DOMAIN}/search?q=${encodeURIComponent(uri)}`, 302);
});

// ---------------------------------------------------------------------------
// Well-Known / Discovery
// ---------------------------------------------------------------------------

app.route('/.well-known/host-meta', hostMeta);
app.route('/nodeinfo', nodeinfo2_0);

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

app.route('/oauth/authorize', oauthAuthorize);
app.route('/oauth/token', oauthToken);
app.route('/oauth/revoke', oauthRevoke);

// ---------------------------------------------------------------------------
// Mastodon API v1
// ---------------------------------------------------------------------------

app.route('/api/v1/apps', apps);
app.route('/api/v1/accounts', accounts);
app.route('/api/v1/timelines', timelines);
app.route('/api/v1/notifications', notifications);
app.route('/api/v1/favourites', favourites);
app.route('/api/v1/bookmarks', bookmarks);
app.route('/api/v1/blocks', blocks);
app.route('/api/v1/mutes', mutes);
app.route('/api/v1/preferences', preferences);
app.route('/api/v1/custom_emojis', customEmojis);
app.route('/api/v1/markers', markers);

app.route('/api/v1/statuses', statuses);
app.route('/api/v1/streaming', streaming);
app.route('/api/v1/push/subscription', push);
app.route('/api/v1/reports', reports);
app.route('/api/v1/polls', polls);
app.route('/api/v1/conversations', conversations);
app.route('/api/v1/follow_requests', followRequests);
app.route('/api/v1/lists', lists);
app.route('/api/v1/tags', tags);
app.route('/api/v1/suggestions', suggestions);
app.route('/api/v1/followed_tags', followedTags);
app.route('/api/v1/featured_tags', featuredTags);
app.route('/api/v1/directory', directory);
app.route('/api/v1/domain_blocks', userDomainBlocks);
app.route('/api/v1/endorsements', endorsements);
app.route('/api/v1/announcements', announcements);
app.route('/api/v1/instance/peers', instancePeers);
app.route('/api/v1/instance/activity', instanceActivity);
app.route('/api/v1/instance', instanceV1);
app.route('/api/v1/instance/rules', rules);
app.route('/api/v1/trends', trends);
app.route('/api/v1/auth/passwords', passwords);
app.route('/api/v1/auth/login', authLogin);
app.route('/api/v1/auth/webauthn', authWebauthn);
app.route('/api/v1/auth/resend_confirmation', resendConfirmation);
app.route('/auth/confirm', emailConfirmPage);
app.route('/api/v1/accounts', changePassword);
app.use('/api/v1/admin/*', createRateLimit(RATE_LIMIT_ADMIN));
app.route('/api/v1/admin', admin);
app.route('/api/v1/export', csvExport);
app.route('/api/v1/import', csvImport);

// ---------------------------------------------------------------------------
// Mastodon API v2
// ---------------------------------------------------------------------------

app.route('/api/v2/instance', instanceV2);
app.route('/api/v2/search', searchV2);
app.route('/api/v2/media', mediaV2);
app.route('/api/v1/media', mediaV2);
app.route('/api/v2/filters', filters);

// ---------------------------------------------------------------------------
// ActivityPub
// ---------------------------------------------------------------------------

app.route('/users', apActor);
app.route('/actor', apInstanceActor);

// Activity wrapper for statuses (Create/Announce) — Hono route because
// Fedify only allows one type per path pattern
app.get('/users/:identifier/statuses/:id/activity', async (c) => {
  const accept = c.req.header('Accept') || '';
  if (!accept.includes('activity+json') && !accept.includes('ld+json')) {
    return c.redirect(`https://${c.env.INSTANCE_DOMAIN}/@${c.req.param('identifier')}/${c.req.param('id')}`);
  }
  return handleActivityRequest(c.env, c.req.param('identifier'), c.req.param('id'));
});

// ---------------------------------------------------------------------------
// Media serving (R2)
// ---------------------------------------------------------------------------

app.route('/media', mediaServe);

// ---------------------------------------------------------------------------
// Media proxy (remote Fediverse media cache)
// ---------------------------------------------------------------------------

app.route('/proxy', proxyEndpoint);

// ---------------------------------------------------------------------------
// Thumbnail / favicon
// ---------------------------------------------------------------------------

// Default avatar SVG (person silhouette on indigo bg)
app.get('/default-avatar.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6366f1"/><circle cx="50" cy="38" r="18" fill="#e0e7ff"/><ellipse cx="50" cy="80" rx="28" ry="22" fill="#e0e7ff"/></svg>`;
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});

// Default header SVG (gradient banner)
app.get('/default-header.svg', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6366f1"/><stop offset="50%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs><rect width="600" height="200" fill="url(#g)"/></svg>`;
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});

app.get('/thumbnail.png', async (c) => {
  // Try R2 first
  const obj = await c.env.MEDIA_BUCKET.get('instance/thumbnail.png');
  if (obj) {
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
  // Fallback: generate a 1x1 transparent PNG
  const pixel = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02,
    0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new Response(pixel, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' },
  });
});

app.get('/favicon.ico', async (c) => {
  const obj = await c.env.MEDIA_BUCKET.get('instance/favicon.ico');
  if (obj) {
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'image/x-icon',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
  // Also try thumbnail.png as favicon fallback
  const thumb = await c.env.MEDIA_BUCKET.get('instance/thumbnail.png');
  if (thumb) {
    return new Response(thumb.body, {
      headers: {
        'Content-Type': thumb.httpMetadata?.contentType || 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
  // Generate a simple SVG favicon
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#6366f1"/><text x="16" y="22" font-size="18" fill="white" text-anchor="middle" font-family="sans-serif" font-weight="bold">S</text></svg>`;
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
  });
});

// ---------------------------------------------------------------------------
// Internal — Stream event delivery (called by queue consumer via service binding)
// ---------------------------------------------------------------------------

app.post('/internal/stream-event', async (c) => {
  const body = await c.req.json<{
    userId: string;
    event: string;
    payload: string;
    stream?: string[];
  }>();

  const { sendStreamEvent } = await import('./services/streaming');
  await sendStreamEvent(c.env.STREAMING_DO, body.userId, {
    event: body.event,
    payload: body.payload,
    stream: body.stream,
  });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Fallback — Mastodon-compatible 404
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Record not found' }, 404));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
