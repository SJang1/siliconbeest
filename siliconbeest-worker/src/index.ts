/**
 * SiliconBeest Worker — Hono App Entry Point
 *
 * Mounts all route groups (Mastodon API, OAuth, ActivityPub, well-known)
 * with global middleware and exports the Cloudflare Workers fetch handler.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';

import type { Env, AppVariables } from './env';
import { corsMiddleware } from './middleware/cors';
import { requestIdMiddleware } from './middleware/requestId';
import { contentNegotiation } from './middleware/contentNegotiation';
import { errorHandler } from './middleware/errorHandler';

// -- Well-Known / Discovery --
import webfinger from './endpoints/wellknown/webfinger';
import nodeinfo from './endpoints/wellknown/nodeinfo';
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

// -- Admin API --
import admin from './endpoints/api/v1/admin/index';

// -- Mastodon API v2 --
import instanceV2 from './endpoints/api/v2/instance';
import searchV2 from './endpoints/api/v2/search';
import mediaV2 from './endpoints/api/v2/media';
import filters from './endpoints/api/v1/filters/index';

// -- ActivityPub --
import apActor from './endpoints/activitypub/actor';
import apInstanceActor from './endpoints/activitypub/instanceActor';
import apInbox from './endpoints/activitypub/inbox';
import apSharedInbox from './endpoints/activitypub/sharedInbox';
import apOutbox from './endpoints/activitypub/outbox';
import apFollowers from './endpoints/activitypub/followers';
import apFollowing from './endpoints/activitypub/following';

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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/healthz', (c) => c.text('ok'));

// ---------------------------------------------------------------------------
// Well-Known / Discovery
// ---------------------------------------------------------------------------

app.route('/.well-known/webfinger', webfinger);
app.route('/.well-known/nodeinfo', nodeinfo);
app.route('/.well-known/host-meta', hostMeta);
app.route('/nodeinfo', nodeinfo);

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
app.route('/api/v1/announcements', announcements);
app.route('/api/v1/instance/rules', rules);
app.route('/api/v1/admin', admin);

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
app.route('/users', apInbox);
app.route('/users', apOutbox);
app.route('/users', apFollowers);
app.route('/users', apFollowing);
app.route('/actor', apInstanceActor);
app.route('/inbox', apSharedInbox);

// ---------------------------------------------------------------------------
// Fallback — Mastodon-compatible 404
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Record not found' }, 404));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
