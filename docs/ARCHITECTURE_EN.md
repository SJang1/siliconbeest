# SiliconBeest Architecture Document

> Comprehensive technical documentation for the SiliconBeest project.
> Last updated: 2026-03-25

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [Database Schema](#4-database-schema)
5. [ActivityPub Implementation](#5-activitypub-implementation)
6. [Mastodon API Compatibility](#6-mastodon-api-compatibility)
7. [Misskey Compatibility](#7-misskey-compatibility)
8. [Queue System](#8-queue-system)
9. [Frontend (Vue 3)](#9-frontend-vue-3)
10. [Admin Features](#10-admin-features)
11. [Security](#11-security)
12. [Scripts & Deployment](#12-scripts--deployment)
13. [Testing](#13-testing)
14. [Known Limitations & Future Work](#14-known-limitations--future-work)
15. [Configuration Reference](#15-configuration-reference)

---

## 1. Project Overview

### What Is SiliconBeest?

SiliconBeest is a **fully serverless Fediverse platform** built entirely on the Cloudflare developer platform (Workers, D1, R2, KV, Queues, Durable Objects). It implements the **Mastodon REST API** and the **ActivityPub** server-to-server protocol, allowing it to federate with the wider Fediverse (Mastodon, Misskey, Pleroma, Akkoma, Firefish, GoToSocial, and others).

- **GitHub Repository**: https://github.com/SJang1/siliconbeest
- **License**: GNU Affero General Public License v3.0 (AGPL-3.0)

### Inspiration

SiliconBeest is inspired by [Cloudflare Wildebeest](https://github.com/cloudflare/wildebeest), which was Cloudflare's official attempt at a serverless Fediverse server. Wildebeest has since been **discontinued** by Cloudflare. SiliconBeest takes the concept further with a complete rewrite featuring:

- Full Mastodon API v1/v2 compatibility (100+ endpoints)
- Comprehensive federation with modern HTTP signature standards
- Queue-based async processing for reliability
- A custom Vue 3 frontend with internationalization
- Admin dashboard for instance management
- Test suite with 680+ tests

### Design Goals

| Goal | Approach |
|------|----------|
| **Zero server infrastructure** | Runs entirely on Cloudflare edge network |
| **Low cost** | Designed to stay within Cloudflare Workers Paid plan ($5/month) |
| **Full compatibility** | Works with existing Mastodon clients (Tusky, Elk, Ice Cubes, Ivory, Mona) |
| **Federation first** | Implements ActivityPub, WebFinger, NodeInfo, HTTP Signatures, LD Signatures, Object Integrity Proofs |
| **Security** | OAuth 2.0 + PKCE, TOTP 2FA, bcrypt passwords, rate limiting |
| **Internationalization** | 12 language packs with lazy loading |

---

## 2. Architecture

### Three-Worker Model

SiliconBeest is composed of three independent Cloudflare Workers that cooperate through shared data stores and queues:

```
                        Clients (Mastodon apps, web browsers)
                                       |
                                       v
                         +---------------------------+
                         |    Cloudflare CDN / Edge   |
                         +---------------------------+
                                       |
                      +----------------+----------------+
                      |                                 |
                      v                                 v
         +------------------------+        +------------------------+
         |   siliconbeest-worker  |        |   siliconbeest-vue     |
         |   (Hono API server)    |        |   (Vue 3 SPA frontend) |
         |                        |        |                        |
         |  - Mastodon API v1/v2  |        |  - Tailwind CSS 4      |
         |  - OAuth 2.0 + 2FA     |        |  - Headless UI         |
         |  - ActivityPub S2S     |        |  - Pinia stores        |
         |  - Admin API           |        |  - vue-i18n            |
         |  - WebSocket streaming |        |  - Sentry (optional)   |
         +------------------------+        +------------------------+
               |     |      |
               v     v      v
         +-----+ +----+ +--------+    +----------------------------+
         |  D1 | | R2 | |   KV   |    | siliconbeest-queue-consumer|
         | SQL | |blob | |cache/  |    |                            |
         | DB  | |store| |session |    |  - Federation delivery     |
         +-----+ +----+ +--------+    |  - Timeline fanout         |
                                       |  - Notifications           |
         +------------------+         |  - Media processing        |
         |   Durable Objects |         |  - Web Push sending        |
         |   (StreamingDO)   |         +----------------------------+
         |   WebSocket live  |               |            |
         +------------------+         +------+     +------+
                                       | Queue |     | Queue |
                                       | fed.  |     | int.  |
                                       +------+     +------+
```

### Worker 1: `siliconbeest-worker` (API Server)

The primary worker handling all HTTP requests. Built with **Hono** web framework.

**Responsibilities:**
- Mastodon REST API v1/v2 (accounts, statuses, timelines, notifications, etc.)
- OAuth 2.0 authorization server (authorization code + PKCE + client_credentials)
- ActivityPub server-to-server endpoints (actor, inbox, outbox, followers, following, featured)
- Well-known discovery (WebFinger, NodeInfo, host-meta)
- WebSocket streaming via Durable Objects
- Media serving from R2
- Admin API

**Key bindings:**
- `DB` (D1) -- primary database
- `MEDIA_BUCKET` (R2) -- media storage
- `CACHE` (KV) -- caching, rate limiting, activity deduplication, signature preference caching
- `SESSIONS` (KV) -- OAuth session management
- `QUEUE_FEDERATION` (Queue) -- enqueue federation jobs
- `QUEUE_INTERNAL` (Queue) -- enqueue internal jobs
- `STREAMING_DO` (Durable Object) -- WebSocket streaming

**Configuration:**
- `placement.mode: "smart"` -- Cloudflare Smart Placement optimizes Worker location near the D1 database
- Routes are configured per custom domain with zone_name-based routing

### Worker 2: `siliconbeest-queue-consumer` (Queue Consumer)

A dedicated worker that consumes messages from both queues and processes them asynchronously.

**Responsibilities:**
- Federation activity delivery to remote inboxes (with HTTP signature signing)
- Activity fanout to all followers' inboxes
- Timeline fanout (inserting statuses into home timelines)
- Notification creation and Web Push delivery
- Remote account and status fetching
- Media thumbnail processing
- Preview card (OpenGraph) fetching
- Activity forwarding with original signature preservation
- CSV import processing (follows, blocks, mutes)

**Key bindings:**
- `DB` (D1), `MEDIA_BUCKET` (R2), `CACHE` (KV) -- same resources as the API worker
- `QUEUE_FEDERATION` + `QUEUE_INTERNAL` -- both as consumer and producer (for re-enqueue)
- `WORKER` (Service binding) -- calls back to the API worker for Durable Object access

**Queue configuration:**
- Federation queue: max 5 retries, Dead Letter Queue (`siliconbeest-federation-dlq`)
- Internal queue: max 3 retries, no DLQ

### Worker 3: `siliconbeest-vue` (Frontend)

A static Vue 3 Single Page Application served as a Cloudflare Workers Site.

**Configuration:**
- `assets.directory: "./dist/client"` -- serves the built Vue app
- `assets.not_found_handling: "single-page-application"` -- all unknown paths serve `index.html` for client-side routing
- Uses `custom_domain: true` routing with a catch-all pattern
- `server/index.ts` -- minimal server entry point for Workers Sites

### Cloudflare Services Used

| Service | Purpose | Why Chosen |
|---------|---------|------------|
| **Workers** | HTTP request handling, API server | Global edge deployment, 0ms cold start, 30s CPU time |
| **D1** | SQLite database | Serverless SQL with zero config, automatic replication |
| **R2** | Object storage (media, emojis) | S3-compatible, no egress fees, integrated with Workers |
| **KV** | Key-value cache | Sub-millisecond reads, global distribution, TTL support |
| **Queues** | Async job processing | Guaranteed delivery, DLQ support, batching |
| **Durable Objects** | WebSocket streaming | Persistent connections, hibernation support, per-user state |

### Request Routing

The API worker uses `zone_name`-based Workers Routes to intercept specific path patterns:

| Route Pattern | Worker | Purpose |
|---------------|--------|---------|
| `domain/api/*` | API Worker | Mastodon REST API |
| `domain/oauth/*` | API Worker | OAuth 2.0 flows |
| `domain/.well-known/*` | API Worker | WebFinger, NodeInfo, host-meta |
| `domain/users/*` | API Worker | ActivityPub actor endpoints |
| `domain/inbox` | API Worker | ActivityPub shared inbox |
| `domain/nodeinfo/*` | API Worker | NodeInfo 2.0/2.1 |
| `domain/media/*` | API Worker | R2 media serving |
| `domain/actor` | API Worker | Instance actor |
| `domain/authorize_interaction*` | API Worker | Remote follow |
| `domain/healthz` | API Worker | Health check |
| `domain/thumbnail.png` | API Worker | Instance thumbnail |
| `domain/favicon.ico` | API Worker | Favicon |
| `domain` (catch-all) | Vue Frontend | SPA catch-all |

### Smart Placement

Both the API worker and queue consumer use `placement.mode: "smart"`. Cloudflare automatically places the Worker close to the D1 database to minimize latency for database operations. This is critical because each API request typically involves multiple D1 queries.

### Cost Considerations

SiliconBeest is designed to operate within the Cloudflare Workers Paid plan ($5/month base):

| Resource | 100 users/mo | 1000 users/mo |
|----------|-------------|---------------|
| Workers requests | ~1.5M (included) | ~15M ($1.50) |
| D1 reads | ~300K (included) | ~3M (included) |
| D1 writes | ~30K (included) | ~300K (included) |
| R2 storage | ~1 GB ($0.02) | ~10 GB ($0.15) |
| KV operations | ~500K (included) | ~5M (included) |
| DO requests | ~300K (included) | ~3M ($0.30) |
| Queues | ~100K (included) | ~1M (included) |
| **Total** | **~$5/mo** | **~$7/mo** |

---

## 3. Project Structure

### Root Directory

```
siliconbeest/
  .gitignore
  FEDERATION.md              # FEP-67ff federation capabilities document
  README.md                  # Project README with quick start guide
  wrangler.jsonc             # Root wrangler config (unused/legacy)
  scripts/                   # Setup, deploy, and maintenance scripts
  siliconbeest-worker/       # API server (Hono on Workers)
  siliconbeest-queue-consumer/ # Async job processor (Queues consumer)
  siliconbeest-vue/          # Web frontend (Vue 3 SPA)
```

### siliconbeest-worker/ (API Server)

```
siliconbeest-worker/
  wrangler.jsonc                    # Worker configuration and bindings
  package.json                      # Dependencies: hono, chanfana, zod, bcryptjs, ulid, worker-mailer
  vitest.config.mts                 # Test configuration with @cloudflare/vitest-pool-workers
  src/
    index.ts                        # Hono app entry point, mounts all routes
    env.ts                          # TypeScript interface for Env bindings and app variables
    types/
      activitypub.ts                # ActivityPub/ActivityStreams type definitions
      mastodon.ts                   # Mastodon REST API entity types
      queue.ts                      # Queue message discriminated union (15 types)
      db.ts                         # Database row types
    endpoints/
      activitypub/
        actor.ts                    # GET /users/:username (AP actor document)
        inbox.ts                    # POST /users/:username/inbox (personal inbox)
        sharedInbox.ts              # POST /inbox (shared inbox)
        outbox.ts                   # GET /users/:username/outbox (paginated)
        followers.ts                # GET /users/:username/followers (paginated)
        following.ts                # GET /users/:username/following (paginated)
        featured.ts                 # GET /users/:username/featured (pinned posts)
        featuredTags.ts             # GET /users/:username/featured_tags
        instanceActor.ts            # GET /actor (instance actor)
      api/v1/
        accounts/
          index.ts                  # Route mounting for all account endpoints
          create.ts                 # POST /api/v1/accounts (registration)
          fetch.ts                  # GET /api/v1/accounts/:id
          verifyCredentials.ts      # GET /api/v1/accounts/verify_credentials
          updateCredentials.ts      # PATCH /api/v1/accounts/update_credentials
          follow.ts                 # POST /api/v1/accounts/:id/follow
          unfollow.ts               # POST /api/v1/accounts/:id/unfollow
          block.ts                  # POST /api/v1/accounts/:id/block
          unblock.ts                # POST /api/v1/accounts/:id/unblock
          mute.ts                   # POST /api/v1/accounts/:id/mute
          unmute.ts                 # POST /api/v1/accounts/:id/unmute
          followers.ts              # GET /api/v1/accounts/:id/followers
          following.ts              # GET /api/v1/accounts/:id/following
          statuses.ts               # GET /api/v1/accounts/:id/statuses
          relationships.ts          # GET /api/v1/accounts/relationships
          search.ts                 # GET /api/v1/accounts/search
          lookup.ts                 # GET /api/v1/accounts/lookup
          aliases.ts                # GET/PUT /api/v1/accounts/aliases
          migration.ts              # POST /api/v1/accounts/migration
          change_password.ts        # POST /api/v1/accounts/change_password
        statuses/
          index.ts                  # Route mounting for all status endpoints
          create.ts                 # POST /api/v1/statuses (compose)
          fetch.ts                  # GET /api/v1/statuses/:id
          delete.ts                 # DELETE /api/v1/statuses/:id
          edit.ts                   # PUT /api/v1/statuses/:id
          context.ts                # GET /api/v1/statuses/:id/context
          favourite.ts              # POST /api/v1/statuses/:id/favourite
          unfavourite.ts            # POST /api/v1/statuses/:id/unfavourite
          reblog.ts                 # POST /api/v1/statuses/:id/reblog
          unreblog.ts               # POST /api/v1/statuses/:id/unreblog
          bookmark.ts               # POST /api/v1/statuses/:id/bookmark
          unbookmark.ts             # POST /api/v1/statuses/:id/unbookmark
          mute.ts                   # POST /api/v1/statuses/:id/mute
          unmute.ts                 # POST /api/v1/statuses/:id/unmute
          pin.ts                    # POST /api/v1/statuses/:id/pin
          unpin.ts                  # POST /api/v1/statuses/:id/unpin
          favouritedBy.ts           # GET /api/v1/statuses/:id/favourited_by
          rebloggedBy.ts            # GET /api/v1/statuses/:id/reblogged_by
          reactions.ts              # GET/POST /api/v1/statuses/:id/reactions (emoji reactions)
        timelines/
          index.ts                  # Route mounting
          home.ts                   # GET /api/v1/timelines/home
          public.ts                 # GET /api/v1/timelines/public (local + federated)
          tag.ts                    # GET /api/v1/timelines/tag/:hashtag
          list.ts                   # GET /api/v1/timelines/list/:id
        notifications/
          index.ts                  # Route mounting
          list.ts                   # GET /api/v1/notifications
          fetch.ts                  # GET /api/v1/notifications/:id
          clear.ts                  # POST /api/v1/notifications/clear
          dismiss.ts                # POST /api/v1/notifications/:id/dismiss
        conversations/
          index.ts                  # Route mounting
          list.ts                   # GET /api/v1/conversations
          delete.ts                 # DELETE /api/v1/conversations/:id
          read.ts                   # POST /api/v1/conversations/:id/read
        polls/
          index.ts                  # Route mounting
          fetch.ts                  # GET /api/v1/polls/:id
          vote.ts                   # POST /api/v1/polls/:id/votes
        lists/
          index.ts                  # CRUD /api/v1/lists + member management
        push/
          index.ts                  # Route mounting
          subscribe.ts              # POST /api/v1/push/subscription
          get.ts                    # GET /api/v1/push/subscription
          update.ts                 # PUT /api/v1/push/subscription
          unsubscribe.ts            # DELETE /api/v1/push/subscription
        filters/
          index.ts                  # CRUD /api/v2/filters
        admin/
          index.ts                  # Route mounting for all admin endpoints
          accounts/
            index.ts                # Route mounting
            list.ts                 # GET /api/v1/admin/accounts
            fetch.ts                # GET /api/v1/admin/accounts/:id
            approve.ts              # POST /api/v1/admin/accounts/:id/approve
            reject.ts               # POST /api/v1/admin/accounts/:id/reject
            action.ts               # POST /api/v1/admin/accounts/:id/action
            role.ts                 # PUT /api/v1/admin/accounts/:id/role
          reports/
            index.ts                # Route mounting
            list.ts                 # GET /api/v1/admin/reports
            fetch.ts                # GET /api/v1/admin/reports/:id
            resolve.ts              # POST /api/v1/admin/reports/:id/resolve
            assign.ts               # POST /api/v1/admin/reports/:id/assign_to_self
          domainBlocks.ts           # CRUD /api/v1/admin/domain_blocks
          domainAllows.ts           # CRUD /api/v1/admin/domain_allows
          ipBlocks.ts               # CRUD /api/v1/admin/ip_blocks
          emailDomainBlocks.ts      # CRUD /api/v1/admin/email_domain_blocks
          rules.ts                  # CRUD /api/v1/admin/instance/rules
          announcements.ts          # CRUD /api/v1/admin/announcements
          customEmojis.ts           # CRUD /api/v1/admin/custom_emojis
          settings.ts               # GET/PATCH /api/v1/admin/instance/settings
          relays.ts                 # CRUD /api/v1/admin/relays
          federation.ts             # GET /api/v1/admin/federation (instance health)
          email.ts                  # POST /api/v1/admin/email (SMTP config)
          measures.ts               # POST /api/v1/admin/measures
        trends/
          index.ts                  # Route mounting
          tags.ts                   # GET /api/v1/trends/tags
          statuses.ts               # GET /api/v1/trends/statuses
        instance/
          activity.ts               # GET /api/v1/instance/activity
          peers.ts                  # GET /api/v1/instance/peers
        apps.ts                     # POST /api/v1/apps (client registration)
        instance.ts                 # GET /api/v1/instance
        favourites.ts               # GET /api/v1/favourites
        bookmarks.ts                # GET /api/v1/bookmarks
        blocks.ts                   # GET /api/v1/blocks
        mutes.ts                    # GET /api/v1/mutes
        preferences.ts              # GET /api/v1/preferences
        customEmojis.ts             # GET /api/v1/custom_emojis
        markers.ts                  # GET/POST /api/v1/markers
        streaming.ts                # GET /api/v1/streaming (WebSocket upgrade)
        reports.ts                  # POST /api/v1/reports
        followRequests.ts           # GET/POST /api/v1/follow_requests
        tags.ts                     # GET/POST /api/v1/tags (follow/unfollow)
        suggestions.ts              # GET /api/v1/suggestions
        announcements.ts            # GET /api/v1/announcements
        rules.ts                    # GET /api/v1/instance/rules
        export.ts                   # GET /api/v1/export (CSV export)
        import.ts                   # POST /api/v1/import (CSV import)
        auth/
          login.ts                  # POST /api/v1/auth/login (email+password)
          passwords.ts              # POST /api/v1/auth/passwords (forgot/reset)
      api/v2/
        instance.ts                 # GET /api/v2/instance (enhanced format)
        search.ts                   # GET /api/v2/search (accounts, statuses, hashtags)
        media.ts                    # POST /api/v2/media (async upload)
      oauth/
        authorize.ts                # GET/POST /oauth/authorize
        token.ts                    # POST /oauth/token
        revoke.ts                   # POST /oauth/revoke
      wellknown/
        webfinger.ts                # GET /.well-known/webfinger
        nodeinfo.ts                 # GET /.well-known/nodeinfo + /nodeinfo/2.0
        hostMeta.ts                 # GET /.well-known/host-meta
      media.ts                      # GET /media/:key (R2 media serving)
    federation/
      actorSerializer.ts            # Serialize local accounts to AP Actor documents
      noteSerializer.ts             # Serialize statuses to AP Note objects
      activityBuilder.ts            # Build AP activities (Create, Update, Delete, etc.)
      deliveryManager.ts            # Manage activity delivery to remote inboxes
      httpSignatures.ts             # HTTP Signature signing + verification (draft-cavage + RFC 9421)
      ldSignatures.ts               # Linked Data Signature creation + verification
      integrityProofs.ts            # Object Integrity Proofs (FEP-8b32, ed25519-jcs-2022)
      activityForwarder.ts          # Forward activities with original signature preservation
      resolveRemoteAccount.ts       # Resolve remote AP actors to local account records
      webfinger.ts                  # WebFinger client for remote account lookup
      inboxProcessors/
        index.ts                    # Dispatch incoming activities to type-specific handlers
        accept.ts                   # Process Accept(Follow)
        announce.ts                 # Process Announce (reblog)
        block.ts                    # Process Block
        create.ts                   # Process Create(Note) -- new remote statuses
        delete.ts                   # Process Delete(Note|Actor)
        emojiReact.ts               # Process EmojiReact (Misskey-compatible)
        flag.ts                     # Process Flag (remote reports)
        follow.ts                   # Process Follow requests
        like.ts                     # Process Like (favourite)
        move.ts                     # Process Move (account migration)
        reject.ts                   # Process Reject(Follow)
        undo.ts                     # Process Undo(Follow|Like|Announce|Block)
        update.ts                   # Process Update(Note|Actor)
    middleware/
      auth.ts                       # Bearer token authentication (KV cache + D1 fallback)
      contentNegotiation.ts         # ActivityPub content type detection
      cors.ts                       # CORS configuration
      errorHandler.ts               # Global error handler
      rateLimit.ts                  # KV-based sliding window rate limiter
      requestId.ts                  # X-Request-ID generation
    repositories/
      account.ts                    # Account CRUD operations
      actorKey.ts                   # RSA/Ed25519 key pair management
      block.ts                      # Block relationship queries
      bookmark.ts                   # Bookmark queries
      favourite.ts                  # Favourite queries
      follow.ts                     # Follow/unfollow operations
      homeTimeline.ts               # Home timeline entry management
      instance.ts                   # Known instance tracking
      media.ts                      # Media attachment CRUD
      mention.ts                    # Mention extraction and storage
      mute.ts                       # Mute relationship queries
      notification.ts               # Notification CRUD
      oauthApp.ts                   # OAuth application registration
      oauthCode.ts                  # OAuth authorization code management
      oauthToken.ts                 # OAuth access token management
      settings.ts                   # Instance settings (D1 key-value)
      status.ts                     # Status CRUD operations
      tag.ts                        # Hashtag management
      user.ts                       # User authentication record management
    services/
      account.ts                    # Account business logic (create, update, delete, migrate)
      auth.ts                       # Authentication logic (login, TOTP verification)
      email.ts                      # SMTP email sending (worker-mailer)
      instance.ts                   # Instance metadata and statistics
      notification.ts               # Notification business logic
      oauth.ts                      # OAuth flow orchestration
      ogFetcher.ts                  # OpenGraph metadata fetcher for URL preview cards
      status.ts                     # Status business logic (compose, edit, delete, context)
      streaming.ts                  # Durable Object streaming helper
      timeline.ts                   # Timeline assembly and enrichment
    utils/
      contentParser.ts              # Parse mentions, hashtags, links from status text
      crypto.ts                     # Cryptographic utilities (AES-GCM, RSA, Ed25519)
      defaultImages.ts              # Default avatar/header SVG generation
      idempotencyKey.ts             # KV-based activity deduplication
      mastodonSerializer.ts         # Convert DB rows to Mastodon API entity format
      pagination.ts                 # Cursor-based pagination with Link headers
      reblogResolver.ts             # Resolve reblog chains
      sanitize.ts                   # HTML sanitization for user content
      statusEnrichment.ts           # Enrich status entities with relationship data
      totp.ts                       # TOTP (RFC 6238) implementation
      ulid.ts                       # ULID generation and validation
    webpush/
      dispatch.ts                   # Web Push dispatch logic
      encrypt.ts                    # RFC 8291 message encryption (aes128gcm)
      vapid.ts                      # VAPID (RFC 8292) token generation
    durableObjects/
      streaming.ts                  # StreamingDO -- Hibernatable WebSocket Durable Object
  migrations/
    0001_initial_schema.sql         # Core schema (35+ tables)
    0002_relays.sql                 # Relay subscriptions table
    0003_status_mutes.sql           # Status mutes table
    0004_emoji_reactions.sql        # Emoji reactions table
    0005_announcements_published_at.sql # Add published_at to announcements
    0006_instances_health.sql       # Add open_registrations to instances
    0007_accounts_inbox.sql         # Add AP endpoint URLs to accounts
    0008_preview_cards.sql          # Preview cards tables
    0009_accounts_remote_columns.sql # Add remote account metadata columns
    0009_accounts_fields.sql        # Add profile metadata fields
    0010_reports_assigned.sql       # Add assigned_account_id to reports
    0011_conversations_ap_uri.sql   # Add AP URI to conversations
    0012_ed25519_keys.sql           # Add Ed25519 key columns for FEP-8b32
    0013_quote_posts.sql            # Add quote_id to statuses (FEP-e232)
    0014_notification_emoji.sql     # Add emoji column to notifications
    0015_statuses_pinned.sql        # Pin/featured status marker
    0016_account_migration.sql      # Add also_known_as and moved_at
  test/
    (49 test files -- see Testing section)
```

### siliconbeest-queue-consumer/ (Queue Consumer)

```
siliconbeest-queue-consumer/
  wrangler.jsonc                    # Worker config with consumer + producer bindings
  package.json                      # Minimal deps: typescript, wrangler
  src/
    index.ts                        # Queue batch handler with message dispatch
    env.ts                          # Environment bindings interface
    handlers/
      deliverActivity.ts            # Deliver a single activity to a remote inbox
      deliverActivityFanout.ts      # Fan out activity to all followers' inboxes
      timelineFanout.ts             # Insert status into followers' home timelines
      createNotification.ts         # Create notification + enqueue Web Push
      processMedia.ts               # Process media thumbnails
      fetchRemoteAccount.ts         # Fetch and cache a remote AP actor
      fetchRemoteStatus.ts          # Fetch and cache a remote AP object
      sendWebPush.ts                # Encrypt and send Web Push notification
      fetchPreviewCard.ts           # Fetch OpenGraph metadata for URL cards
      forwardActivity.ts            # Forward activity with original HTTP headers
      importItem.ts                 # Process CSV import items (follow/block/mute)
      integrityProofs.ts            # Create Object Integrity Proofs for outbound activities
      ldSignatures.ts               # Create LD Signatures for relay activities
    shared/
      types/queue.ts                # Shared queue message type definitions
      webpush.ts                    # Shared Web Push utilities
```

### siliconbeest-vue/ (Frontend)

```
siliconbeest-vue/
  wrangler.jsonc                    # Workers Sites configuration
  package.json                      # Vue 3, Pinia, vue-i18n, Tailwind CSS 4, Headless UI, Sentry
  vite.config.ts                    # Vite build config with @cloudflare/vite-plugin
  vitest.config.ts                  # Vitest config for component tests
  server/
    index.ts                        # Workers Sites server entry
  src/
    main.ts                         # Vue app bootstrap (router, Pinia, i18n, Sentry)
    App.vue                         # Root component
    api/
      client.ts                     # Axios-like API client with auth interceptors
      streaming.ts                  # WebSocket streaming client with auto-reconnect
      mastodon/
        accounts.ts                 # Account API methods
        admin.ts                    # Admin API methods
        bookmarks.ts                # Bookmark API methods
        favourites.ts               # Favourite API methods
        instance.ts                 # Instance API methods
        media.ts                    # Media upload API methods
        notifications.ts            # Notification API methods
        oauth.ts                    # OAuth API methods
        reports.ts                  # Report API methods
        search.ts                   # Search API methods
        statuses.ts                 # Status API methods
        timelines.ts                # Timeline API methods
    components/
      layout/
        AppShell.vue                # Main application shell (sidebar + content)
        Sidebar.vue                 # Navigation sidebar
        MobileNav.vue               # Mobile bottom navigation
        AdminLayout.vue             # Admin panel layout with sidebar
      status/
        StatusCard.vue              # Status display card
        StatusContent.vue           # Rich HTML content renderer
        StatusActions.vue           # Reply, boost, favourite, bookmark, share buttons
        StatusComposer.vue          # Status composition form with media upload
        MediaGallery.vue            # Media attachment gallery with lightbox
        PreviewCard.vue             # URL preview card display
      account/
        AccountCard.vue             # Account display card
        AccountHeader.vue           # Profile header with banner/avatar
        FollowButton.vue            # Follow/unfollow button with state management
      common/
        Avatar.vue                  # User avatar with fallback
        EmojiPicker.vue             # Emoji picker with autocomplete
        ImageViewer.vue             # Full-screen image viewer modal
        InfiniteScroll.vue          # Infinite scroll wrapper component
        LoadingSpinner.vue          # Loading indicator
        Modal.vue                   # Modal dialog
        ReportDialog.vue            # Report submission dialog
        Toast.vue                   # Toast notification
      notification/
        NotificationItem.vue        # Single notification display
      auth/
        LoginForm.vue               # Email + password login form
        RegisterForm.vue            # Registration form
        TwoFactorForm.vue           # TOTP 2FA input form
      settings/
        LanguageSelector.vue        # Language selection dropdown
      timeline/
        TimelineFeed.vue            # Timeline with infinite scroll
    composables/
      useEmojis.ts                  # Emoji autocomplete composable
    stores/
      auth.ts                       # Authentication state (token, current user, 2FA)
      accounts.ts                   # Account cache and relationship management
      statuses.ts                   # Status cache and operations
      timelines.ts                  # Timeline management (home, local, public, tag, list)
      notifications.ts              # Notification list and badge count
      compose.ts                    # Status composition state
      instance.ts                   # Instance configuration and custom emojis
      ui.ts                         # UI state (theme, sidebar, mobile nav, modals)
    router/
      index.ts                      # Vue Router configuration (30+ routes)
      guards.ts                     # Navigation guards (requireAuth, requireAdmin, redirectIfAuthenticated)
    views/
      LandingView.vue               # Public landing page
      HomeView.vue                  # Home timeline
      ExploreView.vue               # Local/public timeline explorer
      AboutView.vue                 # About/instance information page
      SearchView.vue                # Search results page
      TagTimelineView.vue           # Hashtag timeline
      ProfileView.vue               # User profile page
      StatusDetailView.vue          # Single status with context
      FollowListView.vue            # Followers/following list
      LoginView.vue                 # Login page
      RegisterView.vue              # Registration page
      OAuthAuthorizeView.vue        # OAuth authorization consent screen
      ForgotPasswordView.vue        # Password reset request
      ResetPasswordView.vue         # Password reset form
      NotificationsView.vue         # Notification list
      ConversationsView.vue         # Direct message conversations
      BookmarksView.vue             # Bookmarked statuses
      FavouritesView.vue            # Favourited statuses
      ListsView.vue                 # User lists
      ListTimelineView.vue          # List timeline
      FollowRequestsView.vue        # Pending follow requests
      SettingsView.vue              # Settings layout (nested routes)
      SettingsProfileView.vue       # Profile editing
      SettingsAccountView.vue       # Account settings (email, password, 2FA)
      SettingsAppearanceView.vue    # Theme and appearance settings
      SettingsNotificationsView.vue # Notification preferences
      SettingsFiltersView.vue       # Content filter management
      SettingsMigrationView.vue     # Account migration settings
      AdminDashboardView.vue        # Admin dashboard
      AdminAccountsView.vue         # User management
      AdminReportsView.vue          # Report management
      AdminDomainBlocksView.vue     # Domain block management
      AdminSettingsView.vue         # Instance settings
      AdminAnnouncementsView.vue    # Announcement management
      AdminRulesView.vue            # Server rules management
      AdminRelaysView.vue           # Relay management
      AdminCustomEmojisView.vue     # Custom emoji management
      AdminFederationView.vue       # Federation monitoring
      NotFoundView.vue              # 404 page
    i18n/
      index.ts                      # i18n configuration with lazy loading
      locales/
        en.json                     # English translations
        ko.json                     # Korean translations
        (+ 10 more locales loaded lazily)
    types/
      mastodon.ts                   # Frontend Mastodon entity types
  test/
    api/
      client.test.ts                # API client tests
    components/
      Avatar.test.ts                # Avatar component tests
      LoadingSpinner.test.ts        # Loading spinner tests
      StatusActions.test.ts         # Status actions tests
      FollowButton.test.ts          # Follow button tests
    stores/
      auth.test.ts                  # Auth store tests
      ui.test.ts                    # UI store tests
      statuses.test.ts              # Statuses store tests
      timelines.test.ts             # Timelines store tests
    router/
      guards.test.ts                # Router guard tests
    i18n/
      i18n.test.ts                  # i18n configuration tests
```

### scripts/

```
scripts/
  config.sh                 # Shared configuration (PROJECT_PREFIX, resource names, colors)
  config.env.example        # Example persistent configuration overrides
  setup.sh                  # Interactive first-time setup
  deploy.sh                 # Build and deploy all 3 workers
  update.sh                 # Pull, test, migrate, redeploy (production updates)
  configure-domain.sh       # Set up Workers Routes for a custom domain
  generate-vapid-keys.sh    # Generate VAPID key pair (ECDSA P-256)
  seed-admin.sh             # Create admin user account
  migrate.sh                # Apply D1 database migrations
  backup.sh                 # Backup D1 + R2 data
  delete-account.sh         # AP-compliant account deletion
  sync-config.sh            # Sync Cloudflare resource IDs to wrangler.jsonc
  README.md                 # Scripts documentation
```

---

## 4. Database Schema

SiliconBeest uses Cloudflare D1 (SQLite) as its primary database. The schema is managed through 16 migration files.

### ID Strategy: ULID

All primary keys use **ULID** (Universally Unique Lexicographically Sortable Identifier). ULIDs are:

- 26 characters of Crockford Base32
- Time-sortable (first 48 bits are a millisecond timestamp)
- Globally unique without coordination
- Compatible with SQLite TEXT columns

This means `ORDER BY id` is equivalent to `ORDER BY created_at` for most queries, and IDs can be used as pagination cursors.

### All Timestamps

All timestamps are stored as `TEXT` in ISO 8601 format (e.g., `2026-03-25T12:00:00.000Z`).

### Core Tables

#### `accounts`

The central entity representing both local and remote actor profiles.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK, ULID) | Primary key |
| `username` | TEXT | Username (e.g., `admin`) |
| `domain` | TEXT | NULL for local accounts, domain for remote |
| `display_name` | TEXT | Display name |
| `note` | TEXT | Bio (HTML) |
| `uri` | TEXT (UNIQUE) | ActivityPub actor URI |
| `url` | TEXT | Profile page URL |
| `avatar_url` | TEXT | Avatar image URL |
| `avatar_static_url` | TEXT | Static avatar URL |
| `header_url` | TEXT | Header image URL |
| `header_static_url` | TEXT | Static header URL |
| `locked` | INTEGER | Manual follow approval required |
| `bot` | INTEGER | Bot account flag |
| `discoverable` | INTEGER | Discoverable in directory |
| `manually_approves_followers` | INTEGER | AP manuallyApprovesFollowers |
| `statuses_count` | INTEGER | Cached status count |
| `followers_count` | INTEGER | Cached followers count |
| `following_count` | INTEGER | Cached following count |
| `last_status_at` | TEXT | Timestamp of last status |
| `created_at` | TEXT | Account creation timestamp |
| `updated_at` | TEXT | Last update timestamp |
| `suspended_at` | TEXT | Suspension timestamp |
| `silenced_at` | TEXT | Silencing timestamp |
| `memorial` | INTEGER | Memorial account flag |
| `moved_to_account_id` | TEXT | Migration target account |
| `inbox_url` | TEXT | AP inbox URL (migration 0007) |
| `shared_inbox_url` | TEXT | AP shared inbox URL (migration 0007) |
| `outbox_url` | TEXT | AP outbox URL (migration 0007) |
| `featured_collection_url` | TEXT | AP featured collection URL (migration 0007) |
| `fetched_at` | TEXT | Last remote fetch timestamp (migration 0009) |
| `is_bot` | INTEGER | Bot flag (migration 0009) |
| `is_group` | INTEGER | Group account flag (migration 0009) |
| `actor_type` | TEXT | AP actor type (migration 0009) |
| `public_key_pem` | TEXT | Remote actor's public key (migration 0009) |
| `public_key_id` | TEXT | Remote actor's key ID (migration 0009) |
| `followers_url` | TEXT | Remote followers collection URL (migration 0009) |
| `following_url` | TEXT | Remote following collection URL (migration 0009) |
| `fields` | TEXT | JSON array of profile metadata fields (migration 0009) |
| `also_known_as` | TEXT | JSON array of alias URIs (migration 0016) |
| `moved_at` | TEXT | Migration timestamp (migration 0016) |

**Indexes:** `idx_accounts_uri`, `idx_accounts_domain`, `idx_accounts_username_domain`

#### `users`

Local authentication records. 1:1 relationship with `accounts` for local users.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK, ULID) | Primary key |
| `account_id` | TEXT (UNIQUE, FK) | References accounts(id) |
| `email` | TEXT (UNIQUE) | Email address |
| `encrypted_password` | TEXT | bcrypt hash |
| `locale` | TEXT | Preferred language |
| `confirmed_at` | TEXT | Email confirmation timestamp |
| `confirmation_token` | TEXT | Email confirmation token |
| `reset_password_token` | TEXT | Password reset token |
| `reset_password_sent_at` | TEXT | Password reset request timestamp |
| `otp_secret` | TEXT | AES-GCM encrypted TOTP secret |
| `otp_enabled` | INTEGER | 2FA enabled flag |
| `otp_backup_codes` | TEXT | JSON array of hashed backup codes |
| `role` | TEXT | Role: user/moderator/admin |
| `approved` | INTEGER | Approved for login |
| `disabled` | INTEGER | Account disabled flag |
| `sign_in_count` | INTEGER | Total sign-in count |
| `current_sign_in_at` | TEXT | Current session start |
| `last_sign_in_at` | TEXT | Previous session start |
| `current_sign_in_ip` | TEXT | Current IP address |
| `last_sign_in_ip` | TEXT | Previous IP address |
| `chosen_languages` | TEXT | JSON array of preferred languages |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |

**Indexes:** `idx_users_email`, `idx_users_confirmation_token`, `idx_users_reset_password_token`

#### `actor_keys`

RSA and Ed25519 key pairs for federation signing.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK, ULID) | Primary key |
| `account_id` | TEXT (UNIQUE, FK) | References accounts(id) |
| `public_key` | TEXT | RSA-2048 public key (PEM) |
| `private_key` | TEXT | RSA-2048 private key (PEM) |
| `key_id` | TEXT | Key ID URI (e.g., `{actor_uri}#main-key`) |
| `created_at` | TEXT | Creation timestamp |
| `ed25519_public_key` | TEXT | Ed25519 public key (migration 0012) |
| `ed25519_private_key` | TEXT | Ed25519 private key (migration 0012) |

#### `statuses`

Posts (toots/notes).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK, ULID) | Primary key |
| `uri` | TEXT (UNIQUE) | ActivityPub object URI |
| `url` | TEXT | Web page URL |
| `account_id` | TEXT (FK) | Author account |
| `in_reply_to_id` | TEXT | Parent status ID |
| `in_reply_to_account_id` | TEXT | Parent author account ID |
| `reblog_of_id` | TEXT | Original status ID if reblog |
| `text` | TEXT | Source text (for editing) |
| `content` | TEXT | Rendered HTML |
| `content_warning` | TEXT | Spoiler text |
| `visibility` | TEXT | public/unlisted/private/direct |
| `sensitive` | INTEGER | Sensitive content flag |
| `language` | TEXT | Content language code |
| `conversation_id` | TEXT | Conversation thread ID |
| `reply` | INTEGER | Is a reply flag |
| `replies_count` | INTEGER | Cached reply count |
| `reblogs_count` | INTEGER | Cached reblog count |
| `favourites_count` | INTEGER | Cached favourite count |
| `local` | INTEGER | Local origin flag |
| `federated_at` | TEXT | Federation timestamp |
| `edited_at` | TEXT | Last edit timestamp |
| `deleted_at` | TEXT | Soft delete timestamp |
| `poll_id` | TEXT | Associated poll ID |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |
| `quote_id` | TEXT | Quoted status ID (migration 0013) |

**Indexes:** `idx_statuses_account_id`, `idx_statuses_uri`, `idx_statuses_in_reply_to`, `idx_statuses_reblog_of`, `idx_statuses_account_created`, `idx_statuses_visibility_created`, `idx_statuses_local_created`, `idx_statuses_conversation`, `idx_statuses_quote`

#### `media_attachments`

Media files stored in R2.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK, ULID) | Primary key |
| `status_id` | TEXT | Associated status (nullable before attachment) |
| `account_id` | TEXT (FK) | Owner account |
| `file_key` | TEXT | R2 object key |
| `file_content_type` | TEXT | MIME type |
| `file_size` | INTEGER | File size in bytes |
| `thumbnail_key` | TEXT | R2 key for thumbnail |
| `remote_url` | TEXT | Original remote URL |
| `description` | TEXT | Alt text |
| `blurhash` | TEXT | BlurHash for placeholder |
| `width` | INTEGER | Image width |
| `height` | INTEGER | Image height |
| `type` | TEXT | image/video/gifv/audio |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |

### Relationship Tables

#### `follows`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | The follower |
| `target_account_id` | TEXT (FK) | The followed |
| `uri` | TEXT | AP Follow activity URI |
| `show_reblogs` | INTEGER | Show reblogs in timeline |
| `notify` | INTEGER | Notify on new posts |
| `languages` | TEXT | JSON array language filter |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |

**Unique constraint:** `(account_id, target_account_id)`

#### `follow_requests`

Same structure as `follows` but for pending approval.

#### `favourites`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | Who favourited |
| `status_id` | TEXT (FK) | Which status |
| `uri` | TEXT | AP Like activity URI |
| `created_at` | TEXT | Timestamp |

#### `blocks`, `mutes`, `bookmarks`

Standard relationship tables with `account_id` + `target_account_id` or `status_id`.

#### `status_mutes` (migration 0003)

Allows muting notifications from specific statuses (separate from account mutes).

#### `emoji_reactions` (migration 0004)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | Who reacted |
| `status_id` | TEXT (FK) | Which status |
| `emoji` | TEXT | Emoji character or shortcode |
| `custom_emoji_id` | TEXT (FK) | Custom emoji reference |
| `created_at` | TEXT | Timestamp |

### Notification & Mention Tables

#### `notifications`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | Recipient |
| `from_account_id` | TEXT (FK) | Sender |
| `type` | TEXT | mention/follow/favourite/reblog/poll/follow_request/status/update/admin.sign_up/admin.report/emoji_reaction |
| `status_id` | TEXT | Related status (optional) |
| `read` | INTEGER | Read flag |
| `emoji` | TEXT | Emoji for reactions (migration 0014) |
| `created_at` | TEXT | Timestamp |

#### `mentions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `status_id` | TEXT (FK) | Which status |
| `account_id` | TEXT (FK) | Mentioned account |
| `silent` | INTEGER | Silent mention flag |
| `created_at` | TEXT | Timestamp |

### Tags (Hashtags)

#### `tags`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `name` | TEXT (UNIQUE) | Lowercased tag name |
| `display_name` | TEXT | Display version |
| `usable` | INTEGER | Can be used in posts |
| `trendable` | INTEGER | Can appear in trends |
| `listable` | INTEGER | Can appear in listings |
| `last_status_at` | TEXT | Last used timestamp |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |

#### `status_tags`

Join table: `status_id` + `tag_id` (composite PK).

#### `tag_follows`

Allows users to follow hashtags.

### OAuth Tables

#### `oauth_applications`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `name` | TEXT | Application name |
| `website` | TEXT | Application website |
| `redirect_uri` | TEXT | OAuth redirect URI |
| `client_id` | TEXT (UNIQUE) | Client ID |
| `client_secret` | TEXT | Client secret |
| `scopes` | TEXT | Default scopes |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |

#### `oauth_access_tokens`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `token` | TEXT (UNIQUE) | Bearer token |
| `refresh_token` | TEXT (UNIQUE) | Refresh token |
| `application_id` | TEXT (FK) | Associated app |
| `user_id` | TEXT (FK) | Token owner (nullable for client_credentials) |
| `scopes` | TEXT | Granted scopes |
| `expires_at` | TEXT | Expiration timestamp |
| `revoked_at` | TEXT | Revocation timestamp |
| `created_at` | TEXT | Creation timestamp |

#### `oauth_authorization_codes`

Supports PKCE with `code_challenge` and `code_challenge_method` (S256).

### Lists

#### `lists`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | List owner |
| `title` | TEXT | List name |
| `replies_policy` | TEXT | list/followed/none |
| `exclusive` | INTEGER | Exclusive timeline flag |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

#### `list_accounts`

Join table with `list_id`, `account_id`, `follow_id`.

### Federation / Instance Management

#### `instances`

Tracks known remote instances.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `domain` | TEXT (UNIQUE) | Instance domain |
| `software_name` | TEXT | e.g., "mastodon", "misskey" |
| `software_version` | TEXT | Software version |
| `title` | TEXT | Instance title |
| `description` | TEXT | Instance description |
| `inbox_url` | TEXT | Shared inbox URL |
| `public_key` | TEXT | Instance public key |
| `last_successful_at` | TEXT | Last successful delivery |
| `last_failed_at` | TEXT | Last failed delivery |
| `failure_count` | INTEGER | Consecutive failure count |
| `open_registrations` | INTEGER | Registration status (migration 0006) |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Update timestamp |

#### `domain_blocks`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `domain` | TEXT (UNIQUE) | Blocked domain |
| `severity` | TEXT | silence/suspend/noop |
| `reject_media` | INTEGER | Reject media flag |
| `reject_reports` | INTEGER | Reject reports flag |
| `private_comment` | TEXT | Internal note |
| `public_comment` | TEXT | Public note |
| `obfuscate` | INTEGER | Obfuscate domain in lists |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

#### `domain_allows`

Allowlist for federation (domain + timestamps).

#### `relays` (migration 0002)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `inbox_url` | TEXT (UNIQUE) | Relay inbox URL |
| `actor_uri` | TEXT | Relay actor URI |
| `state` | TEXT | idle/pending/accepted/rejected |
| `follow_activity_id` | TEXT | Follow activity ID |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

### Web Push Subscriptions

#### `web_push_subscriptions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `user_id` | TEXT (FK) | Subscriber user |
| `access_token_id` | TEXT (FK) | Associated OAuth token |
| `endpoint` | TEXT | Push service endpoint |
| `key_p256dh` | TEXT | Client public key |
| `key_auth` | TEXT | Client auth secret |
| `alert_mention` | INTEGER | Alert on mentions |
| `alert_follow` | INTEGER | Alert on follows |
| `alert_favourite` | INTEGER | Alert on favourites |
| `alert_reblog` | INTEGER | Alert on reblogs |
| `alert_poll` | INTEGER | Alert on poll results |
| `alert_status` | INTEGER | Alert on new statuses |
| `alert_update` | INTEGER | Alert on status edits |
| `alert_follow_request` | INTEGER | Alert on follow requests |
| `alert_admin_sign_up` | INTEGER | Alert on new sign-ups |
| `alert_admin_report` | INTEGER | Alert on new reports |
| `policy` | TEXT | all/followed/follower/none |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

### Reports & Moderation

#### `reports`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `account_id` | TEXT (FK) | Reporter |
| `target_account_id` | TEXT (FK) | Reported account |
| `status_ids` | TEXT | JSON array of reported status IDs |
| `comment` | TEXT | Report description |
| `category` | TEXT | spam/violation/legal/other |
| `action_taken` | INTEGER | Resolved flag |
| `action_taken_at` | TEXT | Resolution timestamp |
| `action_taken_by_account_id` | TEXT | Moderator who resolved |
| `assigned_account_id` | TEXT | Assigned moderator (migration 0010) |
| `forwarded` | INTEGER | Forwarded to remote flag |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

#### `account_warnings`

Moderator actions on accounts (none/disable/sensitive/silence/suspend).

#### `ip_blocks`

IP-based access control (CIDR notation).

#### `email_domain_blocks`

Blocked email domains for registration.

### Timeline & User Preferences

#### `home_timeline_entries`

Materialized home timeline. Each entry links an `account_id` to a `status_id`.

#### `markers`

Timeline position markers (home, notifications).

#### `user_preferences`

Key-value user preferences.

#### `filters` + `filter_keywords` + `filter_statuses`

Content filtering with keyword matching and status-specific filters.

### Content Tables

#### `preview_cards` (migration 0008)

OpenGraph metadata for URL previews.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `url` | TEXT (UNIQUE) | Source URL |
| `title` | TEXT | Page title |
| `description` | TEXT | Page description |
| `type` | TEXT | link/photo/video/rich |
| `author_name` | TEXT | Author name |
| `author_url` | TEXT | Author URL |
| `provider_name` | TEXT | Provider name |
| `provider_url` | TEXT | Provider URL |
| `image_url` | TEXT | Preview image URL |
| `width` | INTEGER | Image width |
| `height` | INTEGER | Image height |
| `html` | TEXT | Embed HTML |
| `embed_url` | TEXT | Embed URL |
| `blurhash` | TEXT | Image placeholder |
| `created_at` | TEXT | Timestamp |
| `updated_at` | TEXT | Timestamp |

#### `status_preview_cards`

Join table: `status_id` + `preview_card_id`.

#### `settings`

Instance-level key-value settings (registration_mode, site_title, max_toot_chars, etc.).

**Seeded values:**

| Key | Default Value |
|-----|---------------|
| `registration_mode` | `open` |
| `site_title` | `SiliconBeest` |
| `site_description` | (empty) |
| `site_contact_email` | (empty) |
| `site_contact_username` | (empty) |
| `max_toot_chars` | `500` |
| `max_media_attachments` | `4` |
| `max_poll_options` | `4` |
| `poll_max_characters_per_option` | `50` |
| `media_max_image_size` | `16777216` (16 MB) |
| `media_max_video_size` | `104857600` (100 MB) |
| `thumbnail_enabled` | `1` |
| `trends_enabled` | `1` |
| `require_invite` | `0` |
| `min_password_length` | `8` |

#### `custom_emojis`

Custom emoji with R2 storage. `domain = NULL` for local, domain string for remote.

#### `announcements`

Admin announcements with optional start/end dates.

#### `rules`

Instance rules with priority ordering.

#### `conversations` + `conversation_accounts`

Direct message conversation tracking with unread status per participant.
`ap_uri` column (migration 0011) stores the ActivityPub conversation URI.

### Polls

#### `polls`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | ULID |
| `status_id` | TEXT (UNIQUE, FK) | Associated status |
| `expires_at` | TEXT | Expiration timestamp |
| `multiple` | INTEGER | Multiple choice allowed |
| `votes_count` | INTEGER | Total votes |
| `voters_count` | INTEGER | Total voters |
| `options` | TEXT | JSON array of {title, votes_count} |
| `created_at` | TEXT | Timestamp |

#### `poll_votes`

Individual votes with `UNIQUE(poll_id, account_id, choice)`.

---

## 5. ActivityPub Implementation

### Supported Protocols

- **ActivityPub** (W3C Recommendation) -- Server-to-Server
- **WebFinger** (RFC 7033) -- Account discovery
- **NodeInfo 2.0/2.1** -- Instance metadata

### HTTP Signatures

SiliconBeest supports multiple HTTP signature methods for maximum interoperability:

| Method | Direction | Description |
|--------|-----------|-------------|
| `draft-cavage-http-signatures-12` | Sign + Verify | Legacy standard used by most Mastodon-compatible software. RSA-SHA256. |
| RFC 9421 (HTTP Message Signatures) | Sign + Verify | Modern standard. Preferred for outbound delivery. |
| Linked Data Signatures | Sign + Verify | RsaSignature2017 on activity objects for relay forwarding. |
| Object Integrity Proofs (FEP-8b32) | Create + Verify | Ed25519-based DataIntegrityProof with `ed25519-jcs-2022` cryptosuite. |

#### Double-Knock Delivery Strategy

When delivering activities to remote inboxes:

1. **First attempt**: Sign with RFC 9421 HTTP Message Signatures (preferred modern standard)
2. **If rejected** (signature error response): Retry with `draft-cavage-http-signatures-12` (legacy)
3. **Cache preference**: The recipient's preferred signature method is cached in KV for 7 days

This ensures compatibility with both modern and legacy Fediverse servers.

#### Key Types

- **RSA (RSASSA-PKCS1-v1_5, 2048-bit)**: Primary signing key for HTTP Signatures, referenced via `publicKey` on Actor documents
- **Ed25519**: Used for Object Integrity Proofs (FEP-8b32), referenced via `assertionMethod` using `Multikey` type with `publicKeyMultibase` encoding

### Object Integrity Proofs (FEP-8b32)

SiliconBeest creates and verifies `DataIntegrityProof` objects using the `ed25519-jcs-2022` cryptosuite:

- **Outbound**: All outbound activities are signed with the actor's Ed25519 key. The `proof` field is added to the activity JSON.
- **Inbound**: If an incoming activity contains a `proof` field, it is verified against the sender's Ed25519 public key (fetched from their `assertionMethod`).
- **Canonicalization**: JCS (JSON Canonicalization Scheme, RFC 8785) is used for deterministic serialization.

### Actor Serialization

Local accounts are serialized as ActivityPub Actor documents with the following structure:

**Person type** (regular user accounts):
- `@context`: ActivityStreams + security + toot extensions
- `type`: `Person` (or `Service` for bots)
- `id`: `https://{domain}/users/{username}`
- `preferredUsername`, `name`, `summary`
- `inbox`, `outbox`, `followers`, `following`, `featured`, `featuredTags`
- `publicKey`: RSA-2048 public key with key ID `{id}#main-key`
- `assertionMethod`: Ed25519 Multikey for integrity proofs
- `endpoints.sharedInbox`: `https://{domain}/inbox`
- `icon`, `image`: avatar and header attachments
- `attachment`: profile metadata fields as `PropertyValue` objects
- `alsoKnownAs`: alias URIs for account migration
- `movedTo`: migration target URI

**Application type** (instance actor):
- `type`: `Application`
- `preferredUsername`: instance domain
- `manuallyApprovesFollowers`: true
- Own RSA keypair for signing relay activities

### Note Serialization

Statuses are serialized as ActivityPub Note objects:

- `@context`: ActivityStreams + toot extensions
- `type`: `Note`
- `id`: `https://{domain}/users/{username}/statuses/{id}`
- `attributedTo`: author actor URI
- `content`: rendered HTML
- `contentMap`: language-specific content map
- `summary`: content warning (spoiler text)
- `sensitive`: media sensitivity flag
- `published`, `updated`
- `inReplyTo`: parent note URI
- `conversation`: conversation thread URI (tag: URI scheme for local, preserved for remote)
- `url`: web page URL
- `quoteUri`: quoted status URI (FEP-e232)
- `_misskey_quote`: backward compatibility with Misskey

#### Visibility Addressing

| Visibility | `to` | `cc` |
|-----------|------|------|
| Public | `as:Public` | Followers collection + mentioned actors |
| Unlisted | Followers collection | `as:Public` + mentioned actors |
| Followers-only | Followers collection | Mentioned actors |
| Direct | Mentioned actors | (empty) |

#### Tags

- **Mentions**: `{ type: "Mention", href: actorURI, name: "@user@domain" }`
- **Hashtags**: `{ type: "Hashtag", href: tagURL, name: "#tag" }`
- **Custom Emojis**: `{ type: "Emoji", id: emojiURL, name: ":shortcode:", icon: { type: "Image", url: imageURL } }`

#### Attachments

Media attachments are serialized as `Document` objects with `mediaType`, `url`, `name` (alt text), `width`, `height`, `blurhash`.

### Inbox Processing

SiliconBeest processes 13+ incoming activity types:

| Activity | Handler | Description |
|----------|---------|-------------|
| `Create` | `create.ts` | New remote Note -- creates status, extracts mentions/tags, enqueues timeline fanout |
| `Update` | `update.ts` | Updated Note or Actor -- updates local record |
| `Delete` | `delete.ts` | Deleted Note or Actor -- soft deletes locally, sends Tombstone |
| `Follow` | `follow.ts` | Follow request -- auto-accept or create follow_request |
| `Accept` | `accept.ts` | Accepted Follow -- creates follow relationship |
| `Reject` | `reject.ts` | Rejected Follow -- removes follow_request |
| `Like` | `like.ts` | Favourite -- creates favourite record + notification |
| `Announce` | `announce.ts` | Reblog -- creates reblog status + notification |
| `Undo` | `undo.ts` | Undo Follow/Like/Announce/Block -- reverses the original action |
| `Block` | `block.ts` | Block -- creates block, removes any existing follow |
| `Move` | `move.ts` | Account migration -- validates alsoKnownAs, migrates followers |
| `Flag` | `flag.ts` | Remote report -- creates local report record |
| `EmojiReact` | `emojiReact.ts` | Misskey emoji reaction -- creates emoji_reaction record + notification |
| `Add` | (via featured) | Add to featured collection (pin) |
| `Remove` | (via featured) | Remove from featured collection (unpin) |

### Activity Forwarding

When a remote activity targets local followers, SiliconBeest forwards it with the original HTTP headers preserved so the signature can be verified at the destination. This is important for relay scenarios.

### Collection Pagination

All collection endpoints use `OrderedCollection` and `OrderedCollectionPage` with `first`, `next`, and `prev` links:

- `/users/:username/followers` -- paginated follower list
- `/users/:username/following` -- paginated following list
- `/users/:username/outbox` -- paginated outbox with `Create(Note)` activities
- `/users/:username/featured` -- pinned statuses (no pagination)

### WebFinger

Endpoint: `/.well-known/webfinger?resource=acct:user@domain`

- Supports `acct:` URI scheme
- Returns `application/jrd+json`
- Links include:
  - `self` (ActivityPub actor URI, `application/activity+json`)
  - `http://webfinger.net/rel/profile-page` (HTML profile)
- Aliases include both actor URI and profile URL

### NodeInfo 2.0/2.1

Endpoints:
- `/.well-known/nodeinfo` -- links to `/nodeinfo/2.0`
- `/nodeinfo/2.0` -- instance metadata

Exposed metadata:
- Software name and version
- Supported protocols (ActivityPub)
- User count, status count, domain count
- Registration status (open/closed)

### Instance Actor

Exposed at `/actor` with type `Application`:
- Own RSA keypair for signing relay and instance-level activities
- `preferredUsername` set to instance domain
- `manuallyApprovesFollowers: true`
- Shared inbox at `/inbox`

### Relay Support

ActivityPub relay subscriptions managed through the admin API:
- Uses instance actor for authentication
- Relay states: idle, pending, accepted, rejected
- Outbound activities are signed with LD Signatures for relay distribution

### Activity Idempotency

Incoming activities are deduplicated using KV:
- Key: `activity:{sha256(activity.id)}`
- TTL: 7 days
- If an activity ID has already been processed, the duplicate is silently dropped

### Conversation Threading

The `conversation` field on Note objects is supported:
- Local threads use `tag:` URI format: `tag:{domain},{date}:objectId={conversationId}:objectType=Conversation`
- Remote `conversation` values are preserved as-is
- Conversations are tracked in the `conversations` table with per-user read status

### FEP Compliance

| FEP | Title | Status |
|-----|-------|--------|
| FEP-8b32 | Object Integrity Proofs | Full support (create + verify, Ed25519 ed25519-jcs-2022) |
| FEP-8fcf | Followers Collection Synchronization | Supported (paginated followers, alsoKnownAs on actors) |
| FEP-67ff | FEDERATION.md | This document (FEDERATION.md in project root) |
| FEP-e232 | Object Links (Quote Posts) | Supported (quoteUri, _misskey_quote) |

---

## 6. Mastodon API Compatibility

### Implemented Endpoints

SiliconBeest implements 100+ Mastodon-compatible REST API endpoints:

#### OAuth 2.0

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/oauth/authorize` | Authorization page |
| POST | `/oauth/authorize` | Authorization consent |
| POST | `/oauth/token` | Token exchange (authorization_code, client_credentials) |
| POST | `/oauth/revoke` | Token revocation |

#### Applications

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/apps` | Register a client application |

#### Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/accounts` | Register a new account |
| GET | `/api/v1/accounts/verify_credentials` | Get current user |
| PATCH | `/api/v1/accounts/update_credentials` | Update profile |
| GET | `/api/v1/accounts/:id` | Get account |
| GET | `/api/v1/accounts/:id/statuses` | Get account statuses |
| GET | `/api/v1/accounts/:id/followers` | Get followers |
| GET | `/api/v1/accounts/:id/following` | Get following |
| POST | `/api/v1/accounts/:id/follow` | Follow |
| POST | `/api/v1/accounts/:id/unfollow` | Unfollow |
| POST | `/api/v1/accounts/:id/block` | Block |
| POST | `/api/v1/accounts/:id/unblock` | Unblock |
| POST | `/api/v1/accounts/:id/mute` | Mute |
| POST | `/api/v1/accounts/:id/unmute` | Unmute |
| GET | `/api/v1/accounts/relationships` | Get relationships |
| GET | `/api/v1/accounts/search` | Search accounts |
| GET | `/api/v1/accounts/lookup` | Lookup by acct |
| GET/PUT | `/api/v1/accounts/aliases` | Account aliases |
| POST | `/api/v1/accounts/migration` | Account migration |
| POST | `/api/v1/accounts/change_password` | Change password |

#### Statuses

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/statuses` | Create status |
| GET | `/api/v1/statuses/:id` | Get status |
| PUT | `/api/v1/statuses/:id` | Edit status |
| DELETE | `/api/v1/statuses/:id` | Delete status |
| GET | `/api/v1/statuses/:id/context` | Get thread context |
| POST | `/api/v1/statuses/:id/favourite` | Favourite |
| POST | `/api/v1/statuses/:id/unfavourite` | Unfavourite |
| POST | `/api/v1/statuses/:id/reblog` | Reblog |
| POST | `/api/v1/statuses/:id/unreblog` | Unreblog |
| POST | `/api/v1/statuses/:id/bookmark` | Bookmark |
| POST | `/api/v1/statuses/:id/unbookmark` | Unbookmark |
| POST | `/api/v1/statuses/:id/mute` | Mute thread |
| POST | `/api/v1/statuses/:id/unmute` | Unmute thread |
| POST | `/api/v1/statuses/:id/pin` | Pin |
| POST | `/api/v1/statuses/:id/unpin` | Unpin |
| GET | `/api/v1/statuses/:id/favourited_by` | Who favourited |
| GET | `/api/v1/statuses/:id/reblogged_by` | Who reblogged |
| GET/POST | `/api/v1/statuses/:id/reactions` | Emoji reactions |

#### Timelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/timelines/home` | Home timeline |
| GET | `/api/v1/timelines/public` | Public timeline (local + federated) |
| GET | `/api/v1/timelines/tag/:tag` | Hashtag timeline |
| GET | `/api/v1/timelines/list/:id` | List timeline |

#### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/notifications` | List notifications |
| GET | `/api/v1/notifications/:id` | Get notification |
| POST | `/api/v1/notifications/clear` | Clear all |
| POST | `/api/v1/notifications/:id/dismiss` | Dismiss one |

#### Other Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/favourites` | Favourited statuses |
| GET | `/api/v1/bookmarks` | Bookmarked statuses |
| GET | `/api/v1/blocks` | Blocked accounts |
| GET | `/api/v1/mutes` | Muted accounts |
| GET | `/api/v1/preferences` | User preferences |
| GET | `/api/v1/custom_emojis` | Instance custom emojis |
| GET/POST | `/api/v1/markers` | Timeline markers |
| POST | `/api/v1/reports` | File a report |
| GET/POST | `/api/v1/follow_requests` | Follow requests |
| CRUD | `/api/v1/lists` | List management |
| GET/POST | `/api/v1/tags` | Tag follow/unfollow |
| GET | `/api/v1/suggestions` | Follow suggestions |
| GET | `/api/v1/announcements` | Announcements |
| GET | `/api/v1/instance/rules` | Instance rules |
| GET | `/api/v1/trends/tags` | Trending tags |
| GET | `/api/v1/trends/statuses` | Trending statuses |
| GET | `/api/v1/conversations` | Conversations |
| DELETE | `/api/v1/conversations/:id` | Delete conversation |
| POST | `/api/v1/conversations/:id/read` | Mark read |
| GET | `/api/v1/polls/:id` | Get poll |
| POST | `/api/v1/polls/:id/votes` | Vote in poll |
| GET | `/api/v1/export` | CSV export |
| POST | `/api/v1/import` | CSV import |

#### API v2

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v2/instance` | Enhanced instance info |
| GET | `/api/v2/search` | Search (accounts, statuses, hashtags) |
| POST | `/api/v2/media` | Async media upload |
| CRUD | `/api/v2/filters` | Content filters |

#### Streaming

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/streaming` | WebSocket upgrade |

#### Push Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/push/subscription` | Subscribe |
| GET | `/api/v1/push/subscription` | Get subscription |
| PUT | `/api/v1/push/subscription` | Update |
| DELETE | `/api/v1/push/subscription` | Unsubscribe |

#### Instance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/instance` | Instance info (v1) |
| GET | `/api/v2/instance` | Instance info (v2) |
| GET | `/api/v1/instance/peers` | Known peers |
| GET | `/api/v1/instance/activity` | Weekly activity |

#### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/login` | Direct login (email+password) |
| POST | `/api/v1/auth/passwords` | Password reset |

### OAuth 2.0 Flow

SiliconBeest implements a standards-compliant OAuth 2.0 authorization server:

1. **Client Registration**: `POST /api/v1/apps` returns `client_id` and `client_secret`
2. **Authorization**: `GET /oauth/authorize` presents consent screen
3. **Token Exchange**: `POST /oauth/token` with authorization code
4. **PKCE Support**: `code_challenge` and `code_challenge_method` (S256) for public clients
5. **Client Credentials**: `POST /oauth/token` with `grant_type=client_credentials` for server-to-server
6. **Token Revocation**: `POST /oauth/revoke`

### 2FA/TOTP Support

- TOTP (RFC 6238) with AES-GCM encrypted secrets stored in the `users` table
- Backup codes (hashed with bcrypt)
- OTP encryption key stored as a Cloudflare secret (`OTP_ENCRYPTION_KEY`)

### Streaming WebSocket API

Real-time updates via WebSocket using Cloudflare Durable Objects:

- **Endpoint**: `GET /api/v1/streaming?stream={stream_name}`
- **Streams**: `user`, `public`, `public:local`, `hashtag:{tag}`, `list:{id}`, `direct`
- **Events**: `update`, `notification`, `delete`, `status.update`, `filters_changed`
- **Hibernation**: Uses Cloudflare's Hibernatable WebSocket API for cost efficiency
- **Auto-ping/pong**: Configured via `setWebSocketAutoResponse`

### Web Push Notifications

- **VAPID** (RFC 8292): ECDSA P-256 key pair for push service authentication
- **RFC 8291**: Message encryption (aes128gcm content encoding)
- **Per-alert configuration**: Users can enable/disable specific notification types
- **Policy**: all/followed/follower/none

### Pagination

All list endpoints use cursor-based pagination:
- `max_id` / `min_id` / `since_id` query parameters
- `Link` header with `rel="next"` and `rel="prev"` URLs
- IDs are ULIDs (time-sortable), making cursor pagination natural

### Media Uploads

- **Upload**: `POST /api/v2/media` -- uploads to R2, returns media attachment entity
- **Serving**: `GET /media/:key` -- serves from R2 with proper Content-Type
- **Thumbnail processing**: Async via queue
- **Size limits**: 16 MB images, 100 MB video (configurable via settings)
- **Types**: image, video, gifv, audio

### Custom Emoji

- Local custom emojis stored in R2 with metadata in D1
- Remote custom emojis cached when received via federation
- Category support for organization
- Visible/hidden in picker
- Admin CRUD via `/api/v1/admin/custom_emojis`

### URL Preview Cards

- OpenGraph metadata fetched asynchronously via queue
- Cached in `preview_cards` table
- Supports title, description, image, author, provider
- Types: link, photo, video, rich

### Quote Posts

- Supported via `quote_id` column in statuses
- Federated using `quoteUri` property (FEP-e232)
- Backward compatible with `_misskey_quote`

### Filters, Lists, Bookmarks, Favourites

- **Filters** (v2): keyword-based with context (home/notifications/public/thread/account), warn/hide actions, expiration
- **Lists**: user-created lists with replies_policy and exclusive mode
- **Bookmarks**: private bookmarks with pagination
- **Favourites**: public favourites with pagination

### Account Migration

- **Move activity**: Sends `Move(Actor)` to all followers
- **alsoKnownAs**: Validates bidirectional alias
- **CSV export/import**: Following, blocks, mutes lists
- **Import processing**: Async via queue (one item at a time)

---

## 7. Misskey Compatibility

SiliconBeest implements several Misskey-specific extensions for interoperability:

### Content Fields

| Field | Direction | Description |
|-------|-----------|-------------|
| `_misskey_content` | Inbound | Recognized on incoming Note objects for Misskey-formatted MFM content |
| `_misskey_summary` | Inbound | Recognized for content warning text |
| `_misskey_quote` | Both | Quote post reference (backward compat with FEP-e232 `quoteUri`) |
| `_misskey_reaction` | Inbound | Emoji reaction metadata |

### EmojiReact Activity Type

SiliconBeest supports the `EmojiReact` activity type used by Misskey, Calckey, Firefish, and compatible implementations:

- **Inbound**: Processes `EmojiReact` activities, creates `emoji_reactions` records, sends notifications
- **Outbound**: Sends `EmojiReact` activities when users react with emoji
- **Custom emoji**: Both Unicode emoji and custom emoji (`:shortcode:` format) are supported
- **API**: `GET/POST /api/v1/statuses/:id/reactions`

### Custom Emoji Federation

Custom emojis are federated as `Emoji` tags on Note objects:

```json
{
  "type": "Emoji",
  "id": "https://example.com/emojis/blobcat",
  "name": ":blobcat:",
  "icon": {
    "type": "Image",
    "url": "https://example.com/files/blobcat.png"
  }
}
```

Remote custom emojis are cached locally with `domain` set to the source instance.

---

## 8. Queue System

### Two Queues

| Queue | Purpose | Retries | DLQ |
|-------|---------|---------|-----|
| `siliconbeest-federation` | Federation-related jobs (delivery, fetching, forwarding) | 5 | `siliconbeest-federation-dlq` |
| `siliconbeest-internal` | Internal jobs (timeline, notifications, media, trends) | 3 | None |

### Message Types (15 total)

| Type | Queue | Description |
|------|-------|-------------|
| `deliver_activity` | Federation | Deliver a single activity to a specific remote inbox |
| `deliver_activity_fanout` | Federation | Fan out activity delivery to all followers' inboxes |
| `fetch_remote_account` | Federation | Fetch and cache a remote AP actor |
| `fetch_remote_status` | Federation | Fetch and cache a remote AP object |
| `update_instance_info` | Federation | Update known instance metadata |
| `deliver_report` | Federation | Forward a report to a remote instance |
| `forward_activity` | Federation | Forward activity with original HTTP headers preserved |
| `import_item` | Federation | Process a single CSV import item |
| `timeline_fanout` | Internal | Insert a status into all followers' home timelines |
| `create_notification` | Internal | Create a notification record and enqueue Web Push |
| `process_media` | Internal | Process media thumbnails |
| `send_web_push` | Internal | Encrypt and send a Web Push notification |
| `fetch_preview_card` | Internal | Fetch OpenGraph metadata for URL preview |
| `cleanup_expired_tokens` | Internal | Clean up expired OAuth tokens |
| `update_trends` | Internal | Update trending tags/statuses |

### Message Processing

The queue consumer processes messages in a `for` loop over the batch:

1. Switch on `msg.body.type` to dispatch to the correct handler
2. On success: `msg.ack()`
3. On error: `msg.retry()` (up to max retries, then DLQ for federation queue)

### Instance Health Tracking

The `instances` table tracks delivery success/failure:
- `last_successful_at`: timestamp of last successful delivery
- `last_failed_at`: timestamp of last failed delivery
- `failure_count`: consecutive failure count
- Used to implement backoff for unreachable instances

---

## 9. Frontend (Vue 3)

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Vue 3 | ^3.5.29 | Reactive UI framework |
| Vite | ^7.3.1 | Build tool |
| Tailwind CSS 4 | ^4.2.2 | Utility-first CSS |
| Pinia | ^3.0.4 | State management |
| vue-i18n | ^11.3.0 | Internationalization |
| vue-router | ^5.0.3 | Client-side routing |
| @headlessui/vue | ^1.7.23 | Accessible UI components |
| @sentry/vue | ^10.45.0 | Error tracking (optional) |
| @vueuse/core | ^14.2.1 | Vue composition utilities |

### Component Architecture

Components are organized by domain:

| Category | Components | Purpose |
|----------|-----------|---------|
| **layout** | AppShell, Sidebar, MobileNav, AdminLayout | Application frame and navigation |
| **status** | StatusCard, StatusContent, StatusActions, StatusComposer, MediaGallery, PreviewCard | Status display and creation |
| **account** | AccountCard, AccountHeader, FollowButton | Account display and interaction |
| **common** | Avatar, EmojiPicker, ImageViewer, InfiniteScroll, LoadingSpinner, Modal, ReportDialog, Toast | Shared UI components |
| **notification** | NotificationItem | Notification display |
| **auth** | LoginForm, RegisterForm, TwoFactorForm | Authentication forms |
| **settings** | LanguageSelector | Settings UI components |
| **timeline** | TimelineFeed | Timeline with infinite scroll |

### Routing (30+ routes)

| Path | Guard | View |
|------|-------|------|
| `/` | redirectIfAuthenticated | LandingView |
| `/home` | requireAuth | HomeView |
| `/explore/:tab` | (none) | ExploreView |
| `/about` | (none) | AboutView |
| `/search` | (none) | SearchView |
| `/tags/:tag` | (none) | TagTimelineView |
| `/login` | redirectIfAuthenticated | LoginView |
| `/register` | redirectIfAuthenticated | RegisterView |
| `/oauth/authorize` | (none) | OAuthAuthorizeView |
| `/auth/forgot-password` | (none) | ForgotPasswordView |
| `/auth/reset-password` | (none) | ResetPasswordView |
| `/notifications` | requireAuth | NotificationsView |
| `/conversations` | requireAuth | ConversationsView |
| `/bookmarks` | requireAuth | BookmarksView |
| `/favourites` | requireAuth | FavouritesView |
| `/lists` | requireAuth | ListsView |
| `/lists/:id` | requireAuth | ListTimelineView |
| `/follow-requests` | requireAuth | FollowRequestsView |
| `/settings/profile` | requireAuth | SettingsProfileView |
| `/settings/account` | requireAuth | SettingsAccountView |
| `/settings/appearance` | requireAuth | SettingsAppearanceView |
| `/settings/notifications` | requireAuth | SettingsNotificationsView |
| `/settings/filters` | requireAuth | SettingsFiltersView |
| `/settings/migration` | requireAuth | SettingsMigrationView |
| `/admin` | requireAdmin | AdminDashboardView |
| `/admin/accounts` | requireAdmin | AdminAccountsView |
| `/admin/reports` | requireAdmin | AdminReportsView |
| `/admin/domain-blocks` | requireAdmin | AdminDomainBlocksView |
| `/admin/settings` | requireAdmin | AdminSettingsView |
| `/admin/announcements` | requireAdmin | AdminAnnouncementsView |
| `/admin/rules` | requireAdmin | AdminRulesView |
| `/admin/relays` | requireAdmin | AdminRelaysView |
| `/admin/custom-emojis` | requireAdmin | AdminCustomEmojisView |
| `/admin/federation` | requireAdmin | AdminFederationView |
| `/@:acct` | (none) | ProfileView |
| `/@:acct/followers` | (none) | FollowListView |
| `/@:acct/following` | (none) | FollowListView |
| `/@:acct/:statusId` | (none) | StatusDetailView |

URL-encoded `%40` (for `@`) is handled via redirects.

### Stores (Pinia)

| Store | State | Purpose |
|-------|-------|---------|
| `auth` | token, currentUser, 2FA state | Authentication and session |
| `accounts` | account cache, relationships | Account data and interactions |
| `statuses` | status cache, context | Status data and operations |
| `timelines` | home, local, public, tag, list feeds | Timeline assembly |
| `notifications` | notification list, unread count | Notifications |
| `compose` | draft text, media, poll, visibility | Status composition |
| `instance` | instance config, custom emojis, rules | Instance metadata |
| `ui` | theme, sidebar state, mobile nav, modals, toasts | UI state management |

### Internationalization (i18n)

12 supported locales with lazy loading:

| Code | Language | Direction |
|------|----------|-----------|
| `en` | English | LTR |
| `ko` | Korean | LTR |
| `ja` | Japanese | LTR |
| `zh-CN` | Simplified Chinese | LTR |
| `zh-TW` | Traditional Chinese | LTR |
| `es` | Spanish | LTR |
| `fr` | French | LTR |
| `de` | German | LTR |
| `pt-BR` | Brazilian Portuguese | LTR |
| `ru` | Russian | LTR |
| `ar` | Arabic | **RTL** |
| `id` | Indonesian | LTR |

English is loaded eagerly as the default. All other locales are loaded lazily on demand via dynamic `import()`.

### Streaming (WebSocket)

The `api/streaming.ts` module provides a WebSocket client that:
- Connects to `/api/v1/streaming?stream={name}`
- Auto-reconnects on disconnection with exponential backoff
- Dispatches events to Pinia stores (new statuses, notifications, deletions)
- Handles multiple stream subscriptions simultaneously

### Sentry Integration

Optional error tracking via `@sentry/vue`:
- Configured via `VITE_SENTRY_DSN` environment variable
- Integrates with Vue error handler
- Captures unhandled exceptions and API errors

### Image Viewer Modal

Full-screen image viewer with:
- Keyboard navigation (arrows, escape)
- Pinch-to-zoom on mobile
- Image download

### Emoji Picker

Custom emoji picker with:
- Unicode emoji categories
- Instance custom emojis
- Autocomplete (`:shortcode` trigger)
- Search/filter functionality

### Responsive Design

- Mobile-first with Tailwind CSS 4
- Bottom navigation on mobile (`MobileNav.vue`)
- Sidebar navigation on desktop (`Sidebar.vue`)
- System-aware dark mode with manual toggle

---

## 10. Admin Features

### Admin Panel

The admin panel is accessible at `/admin` and requires the `requireAdmin` navigation guard. It uses `AdminLayout.vue` with a sidebar navigation.

### User Management (`/admin/accounts`)

- **List accounts** with filtering (local, remote, active, pending, suspended, silenced)
- **Approve** pending registration requests
- **Reject** pending registrations
- **Silence** accounts (limits visibility)
- **Suspend** accounts (fully blocked)
- **Change roles**: user, moderator, admin
- **Custom actions** via `/api/v1/admin/accounts/:id/action`

### Reports Management (`/admin/reports`)

- **List reports** with status filtering (open, resolved)
- **View report details** including reported statuses
- **Assign** reports to moderators
- **Resolve** reports with action
- **Forward** reports to remote instances

### Domain Blocks (`/admin/domain-blocks`)

- **Create** domain blocks with severity (silence, suspend, noop)
- **Options**: reject media, reject reports, obfuscate domain
- **Public/private comments**
- **Domain allows** for allowlist mode

### Custom Emoji Management (`/admin/custom-emojis`)

- **Upload** custom emojis (stored in R2)
- **Categorize** emojis
- **Toggle** picker visibility
- **Delete** emojis

### Announcements (`/admin/announcements`)

- **Create** announcements with optional start/end dates
- **Publish/unpublish** announcements
- **All-day** event support
- **Edit/delete** announcements

### Rules (`/admin/rules`)

- **Create** instance rules
- **Reorder** by priority
- **Edit/delete** rules

### Federation Monitoring (`/admin/federation`)

- **Instance health** dashboard
- **Delivery success/failure** statistics
- **Known instances** list with software info
- **Failure count** tracking

### Relay Management (`/admin/relays`)

- **Add** relay subscriptions
- **Monitor** relay state (idle, pending, accepted, rejected)
- **Remove** relay subscriptions

### SMTP Email Configuration (`/admin/settings`)

- Configure SMTP settings: host, port, user, password, from address
- Used for password reset emails and notification emails

### Instance Settings (`/admin/settings`)

- **Branding**: site title, description, thumbnail
- **Contact**: admin email, admin username
- **Registration**: open, approval required, closed
- **Limits**: max characters, media attachments, poll options
- **Features**: trends, thumbnail generation

### Measures (`/admin/measures`)

- POST `/api/v1/admin/measures` for analytics data
- Metrics include: new users, active users, interactions, etc.

---

## 11. Security

### HTTP Signature Verification

- **Timestamp validation**: Incoming signatures are checked for freshness (Date header within +-300 seconds)
- **Digest verification**: Body digest is validated against the Digest header
- **Key fetching**: Public keys are fetched from the sender's actor document
- **Signature algorithm**: RSA-SHA256 for draft-cavage, configurable for RFC 9421

### Content-Type Validation

- Inbox endpoints validate that incoming requests have proper ActivityPub content types:
  - `application/activity+json`
  - `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`

### Rate Limiting

KV-based sliding window rate limiter (`middleware/rateLimit.ts`):

| Preset | Limit | Window |
|--------|-------|--------|
| `RATE_LIMIT_GENERAL` | 300 requests | 5 minutes |
| `RATE_LIMIT_AUTH` | 30 requests | 5 minutes |
| `RATE_LIMIT_REGISTRATION` | 5 requests | 5 minutes |

Key format: `rl:{ip}:{endpoint}:{windowId}`

Response headers:
- `X-RateLimit-Limit`: maximum requests
- `X-RateLimit-Remaining`: remaining requests
- `Retry-After`: seconds until window reset (on 429)

### CORS Configuration

CORS middleware allows cross-origin requests from Mastodon client applications with appropriate headers.

### Password Hashing

- **bcrypt** via `bcryptjs` library
- Passwords are hashed on registration and login verification

### TOTP 2FA

- **RFC 6238** TOTP implementation
- OTP secrets encrypted with **AES-GCM** using the `OTP_ENCRYPTION_KEY` Cloudflare secret
- **Backup codes**: one-time-use codes hashed with bcrypt
- Enforced during OAuth token exchange when enabled

### VAPID Authentication

- **RFC 8292** VAPID for Web Push authentication
- ECDSA P-256 key pair generated by `generate-vapid-keys.sh`
- Keys stored as Cloudflare secrets

### Bot Protection

Cloudflare's Bot Fight Mode can break federation (blocking ActivityPub requests as bots). A WAF Skip rule is required:

```
(http.request.uri.path matches "^/users/.*" or
 http.request.uri.path eq "/inbox" or
 http.request.uri.path eq "/actor" or
 http.request.uri.path matches "^/nodeinfo/.*" or
 http.request.uri.path matches "^/.well-known/.*")
```

### HTML Sanitization

User-generated HTML content is sanitized to prevent XSS:
- `utils/sanitize.ts` strips dangerous tags and attributes
- Only allowed HTML tags and attributes pass through
- Applied to incoming federated content and locally composed statuses

---

## 12. Scripts & Deployment

### Script Configuration

All scripts source `scripts/config.sh` which defines resource names based on `PROJECT_PREFIX`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_PREFIX` | `siliconbeest` | Master prefix for all resources |
| `WORKER_NAME` | `{prefix}-worker` | API Worker |
| `CONSUMER_NAME` | `{prefix}-queue-consumer` | Queue Consumer |
| `VUE_NAME` | `{prefix}-vue` | Frontend Worker |
| `D1_DATABASE_NAME` | `{prefix}-db` | D1 database |
| `R2_BUCKET_NAME` | `{prefix}-media` | R2 bucket |
| `KV_CACHE_TITLE` | `{prefix}-CACHE` | Cache KV |
| `KV_SESSIONS_TITLE` | `{prefix}-SESSIONS` | Sessions KV |
| `QUEUE_FEDERATION` | `{prefix}-federation` | Federation queue |
| `QUEUE_INTERNAL` | `{prefix}-internal` | Internal queue |
| `QUEUE_DLQ` | `{prefix}-federation-dlq` | Dead letter queue |

**Customization options:**
1. Environment variable: `PROJECT_PREFIX=myserver ./scripts/setup.sh`
2. Persistent file: `scripts/config.env`
3. Individual overrides: `export D1_DATABASE_NAME=my-custom-db`

### setup.sh

Interactive first-time setup:

1. Prompts for project prefix, instance domain, title, registration mode, admin credentials, Sentry DSN
2. Creates D1 database, R2 bucket, KV namespaces, Queues
3. Generates VAPID key pair (ECDSA P-256) and OTP encryption key
4. Updates all `wrangler.jsonc` files with resource IDs
5. Sets secrets via `wrangler secret put`
6. Applies D1 migrations
7. Creates admin user
8. Writes `siliconbeest-vue/.env`

### deploy.sh

Build and deploy all 3 workers:

| Flag | Description |
|------|-------------|
| `--domain <domain>` | Configure Workers Routes for custom domain |
| `--dry-run` | Show what would be deployed |
| `--skip-migrations` | Skip D1 migration step |

### update.sh

Production update workflow:

1. `git pull` (shows changelog)
2. `npm install` for all projects
3. TypeScript type check
4. Run tests
5. Apply D1 migrations
6. Build frontend
7. Deploy all workers

| Flag | Description |
|------|-------------|
| `--branch <name>` | Git branch to pull |
| `--skip-pull` | Use current working tree |
| `--skip-tests` | Skip test step |
| `--dry-run` | Check without deploying |

### configure-domain.sh

Standalone domain configuration (without redeployment):
- Creates Workers Routes for API paths to the API Worker
- Creates catch-all route to the Vue Frontend

### generate-vapid-keys.sh

Generate ECDSA P-256 key pair for VAPID Web Push:
- `--set-secrets` flag to store in Cloudflare

### seed-admin.sh

Create admin user:
- Interactive or with arguments: `./scripts/seed-admin.sh email username password`

### migrate.sh

Apply D1 migrations:
- `--local` for development
- `--remote` for production (default)
- `--dry-run` to list pending

### backup.sh

Backup D1 + R2:
- `--skip-r2` for D1 only
- `--output-dir` for custom location

### delete-account.sh

AP-compliant account deletion:
- Sends `Delete(Actor)` to all known federated servers
- Removes account from local database
- `--all --confirm` for server shutdown

### sync-config.sh

Sync Cloudflare resource IDs to wrangler.jsonc:
- Fetches D1, KV, R2, Queue IDs from Cloudflare API
- Regenerates all 3 wrangler.jsonc files
- `--apply` to write files (default is dry run)

---

## 13. Testing

### Test Framework

- **Vitest** with `@cloudflare/vitest-pool-workers` for Workers runtime testing
- Tests run in the actual Cloudflare Workers runtime environment
- D1 database is available in tests (in-memory)

### Worker Tests (49 files)

| Test File | Coverage Area |
|-----------|--------------|
| `accounts.test.ts` | Account CRUD, profile updates, relationships |
| `activity-idempotency.test.ts` | KV-based activity deduplication |
| `activitypub.test.ts` | AP inbox processing, activity handling |
| `actor-serializer.test.ts` | Actor document serialization |
| `admin-announcements.test.ts` | Admin announcement CRUD |
| `admin-domain-blocks.test.ts` | Domain block management |
| `admin-role.test.ts` | Role changes |
| `admin-rules.test.ts` | Instance rules CRUD |
| `admin.test.ts` | Admin account management |
| `auth.test.ts` | Authentication, login, token management |
| `blocks-mutes.test.ts` | Block and mute operations |
| `bookmarks-favourites.test.ts` | Bookmark and favourite operations |
| `collection-pagination.test.ts` | AP collection pagination |
| `content-parser.test.ts` | Mention, hashtag, link parsing |
| `conversations.test.ts` | DM conversation management |
| `custom-emojis.test.ts` | Custom emoji CRUD |
| `discovery.test.ts` | WebFinger, NodeInfo discovery |
| `ed25519-crypto.test.ts` | Ed25519 key operations |
| `emoji-reactions.test.ts` | Emoji reaction operations |
| `featured-collections.test.ts` | Pin/unpin, featured collection |
| `filters.test.ts` | Content filter CRUD |
| `follow-requests.test.ts` | Follow request management |
| `health.test.ts` | Health check endpoint |
| `http-signatures.test.ts` | HTTP signature signing and verification |
| `instance-v1.test.ts` | Instance info v1 endpoint |
| `instance.test.ts` | Instance v2 endpoint |
| `integrity-proofs.test.ts` | FEP-8b32 Object Integrity Proofs |
| `ld-signatures.test.ts` | Linked Data Signature operations |
| `lists.test.ts` | List CRUD and member management |
| `markers.test.ts` | Timeline markers |
| `mastodon-serializer.test.ts` | DB row to Mastodon entity conversion |
| `media.test.ts` | Media upload and serving |
| `migration.test.ts` | Account migration (Move activity) |
| `nodeinfo.test.ts` | NodeInfo endpoint |
| `note-serializer.test.ts` | Note/status AP serialization |
| `notifications.test.ts` | Notification CRUD |
| `oauth-flow.test.ts` | Full OAuth 2.0 flow + PKCE |
| `pagination.test.ts` | Cursor-based pagination |
| `passwords.test.ts` | Password reset flow |
| `quote-posts.test.ts` | Quote post creation and federation |
| `relays.test.ts` | Relay subscription management |
| `reports.test.ts` | Report filing and moderation |
| `sanitize.test.ts` | HTML sanitization |
| `search.test.ts` | Search functionality |
| `statuses.test.ts` | Status CRUD, visibility, threading |
| `tags.test.ts` | Hashtag management |
| `timelines.test.ts` | Timeline assembly |
| `ulid.test.ts` | ULID generation and validation |
| `webfinger-enhanced.test.ts` | Enhanced WebFinger tests |

### Vue Frontend Tests (11 files)

| Test File | Coverage Area |
|-----------|--------------|
| `api/client.test.ts` | API client configuration and interceptors |
| `components/Avatar.test.ts` | Avatar component rendering |
| `components/LoadingSpinner.test.ts` | Loading spinner component |
| `components/StatusActions.test.ts` | Status action buttons |
| `components/FollowButton.test.ts` | Follow button state management |
| `stores/auth.test.ts` | Auth store (login, logout, token) |
| `stores/ui.test.ts` | UI store (theme, sidebar, modals) |
| `stores/statuses.test.ts` | Statuses store operations |
| `stores/timelines.test.ts` | Timeline store management |
| `router/guards.test.ts` | Navigation guard logic |
| `i18n/i18n.test.ts` | i18n configuration and locale loading |

### Running Tests

```bash
# API worker tests (49 files)
cd siliconbeest-worker && npm test

# Vue frontend tests (11 files)
cd siliconbeest-vue && npm test

# Run all tests
cd siliconbeest-worker && npm test && cd ../siliconbeest-vue && npm test
```

---

## 14. Known Limitations & Future Work

### Cloudflare Workers Constraints

| Constraint | Limit | Impact |
|-----------|-------|--------|
| CPU time per request | 30s (Paid) | Complex federation operations may need chunking |
| Subrequest limit | 50 per request (Paid: 1000) | Fan-out to many followers requires queue batching |
| Body size | 100 MB | Large media uploads may fail |
| D1 row size | ~1 MB | Very long status content may truncate |
| KV value size | 25 MB | Large cached objects need splitting |

### D1 Limitations

- **SQLite-based**: No stored procedures, limited query complexity
- **No JOINs across databases**: Single D1 database for all data
- **Eventual consistency**: Global read replicas may lag slightly
- **No full-text search**: Search is basic `LIKE` queries (no FTS5)

### No Container Support

SiliconBeest avoids Cloudflare Containers to keep costs low. This means:
- No heavy image processing (no ImageMagick/Sharp)
- Limited video transcoding
- BlurHash generation is simplified

### Areas for Improvement

- Full-text search (potentially using Workers AI or external service)
- Video transcoding pipeline
- Advanced media processing (image optimization, format conversion)
- Additional FEP implementations
- Performance optimization for high-follower accounts
- E2E encryption for direct messages
- Plugin system for extensions

---

## 15. Configuration Reference

### Environment Variables (wrangler.jsonc vars)

| Variable | Worker | Description | Example |
|----------|--------|-------------|---------|
| `INSTANCE_DOMAIN` | API | Instance domain name | `social.example.com` |
| `INSTANCE_TITLE` | API | Instance display name | `My Fediverse Server` |
| `REGISTRATION_MODE` | API | open / approval / closed | `open` |

### Secrets (Cloudflare Secrets, never in code)

| Secret | Workers | Description | Set By |
|--------|---------|-------------|--------|
| `VAPID_PRIVATE_KEY` | API, Queue Consumer | ECDSA P-256 private key (base64url) | `setup.sh` |
| `VAPID_PUBLIC_KEY` | API, Queue Consumer | ECDSA P-256 public key (base64url) | `setup.sh` |
| `OTP_ENCRYPTION_KEY` | API | AES-GCM key for TOTP secrets | `setup.sh` |
| `SMTP_HOST` | API | SMTP server hostname (optional) | Admin settings |
| `SMTP_PORT` | API | SMTP server port (optional) | Admin settings |
| `SMTP_USER` | API | SMTP username (optional) | Admin settings |
| `SMTP_PASS` | API | SMTP password (optional) | Admin settings |
| `SMTP_FROM` | API | SMTP from address (optional) | Admin settings |

### Wrangler Bindings

#### API Worker (`siliconbeest-worker/wrangler.jsonc`)

| Binding | Type | Name |
|---------|------|------|
| `DB` | D1 Database | `siliconbeest-db` |
| `MEDIA_BUCKET` | R2 Bucket | `siliconbeest-media` |
| `CACHE` | KV Namespace | (by ID) |
| `SESSIONS` | KV Namespace | (by ID) |
| `QUEUE_FEDERATION` | Queue Producer | `siliconbeest-federation` |
| `QUEUE_INTERNAL` | Queue Producer | `siliconbeest-internal` |
| `STREAMING_DO` | Durable Object | `StreamingDO` class |

#### Queue Consumer (`siliconbeest-queue-consumer/wrangler.jsonc`)

| Binding | Type | Name |
|---------|------|------|
| `DB` | D1 Database | `siliconbeest-db` |
| `MEDIA_BUCKET` | R2 Bucket | `siliconbeest-media` |
| `CACHE` | KV Namespace | (by ID) |
| `QUEUE_FEDERATION` | Queue Producer/Consumer | `siliconbeest-federation` |
| `QUEUE_INTERNAL` | Queue Producer/Consumer | `siliconbeest-internal` |
| `WORKER` | Service Binding | `siliconbeest-worker` |

#### Vue Frontend (`siliconbeest-vue/wrangler.jsonc`)

No service bindings. Static asset serving only.

### Frontend Environment (`siliconbeest-vue/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_INSTANCE_DOMAIN` | Yes | Instance domain (for meta tags) |
| `VITE_VAPID_PUBLIC_KEY` | Yes | VAPID public key (for Web Push subscription) |
| `VITE_SENTRY_DSN` | No | Sentry DSN for error tracking |

### Instance Settings (D1 `settings` table)

These are runtime-configurable via the admin API:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `registration_mode` | string | `open` | open/approval/closed |
| `site_title` | string | `SiliconBeest` | Instance name |
| `site_description` | string | (empty) | Instance description |
| `site_contact_email` | string | (empty) | Contact email |
| `site_contact_username` | string | (empty) | Contact account |
| `max_toot_chars` | number | `500` | Maximum status characters |
| `max_media_attachments` | number | `4` | Maximum media per status |
| `max_poll_options` | number | `4` | Maximum poll options |
| `poll_max_characters_per_option` | number | `50` | Maximum characters per poll option |
| `media_max_image_size` | number | `16777216` | Maximum image size (bytes) |
| `media_max_video_size` | number | `104857600` | Maximum video size (bytes) |
| `thumbnail_enabled` | boolean | `1` | Enable thumbnail generation |
| `trends_enabled` | boolean | `1` | Enable trending features |
| `require_invite` | boolean | `0` | Require invitation to register |
| `min_password_length` | number | `8` | Minimum password length |

---

## Appendix: Domain Change Warning

> **CRITICAL**: Do not change your instance domain after federating. ActivityPub actor URIs contain the domain and are permanent identifiers across the Fediverse. Changing the domain after other servers have cached your actors will break all existing federation relationships, followers, and conversations. Choose your domain carefully before launch.
