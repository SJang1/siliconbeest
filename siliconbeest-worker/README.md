# SiliconBeest Worker

The API server for SiliconBeest. Built with [Hono](https://hono.dev/) on Cloudflare Workers, it implements the Mastodon API (v1 and v2) and the ActivityPub server-to-server protocol.

---

## What It Does

- Serves the full Mastodon-compatible REST API so existing clients (Ivory, Ice Cubes, Tusky, Elk, etc.) work out of the box.
- Handles ActivityPub federation -- receiving and sending activities to/from remote servers.
- Manages OAuth 2.0 authorization flows and TOTP two-factor authentication.
- Provides an admin API for instance management and moderation.
- Exposes WebSocket streaming through a Durable Object.
- Enqueues async jobs (federation delivery, notifications, media processing, preview cards) to Cloudflare Queues.
- Sends email via worker-mailer (password reset, notifications).

---

## Cloudflare Bindings

| Binding            | Service         | Purpose                                  |
| ------------------ | --------------- | ---------------------------------------- |
| `DB`               | D1 (SQLite)     | Primary database for all application data |
| `MEDIA_BUCKET`     | R2              | Media file storage (images, avatars)     |
| `CACHE`            | KV              | Response caching, rate limit counters    |
| `SESSIONS`         | KV              | OAuth session storage                    |
| `QUEUE_FEDERATION` | Queues          | Federation activity delivery jobs        |
| `QUEUE_INTERNAL`   | Queues          | Internal jobs (notifications, fanout)    |
| `STREAMING_DO`     | Durable Objects | WebSocket streaming connections          |

---

## API Endpoints

### Well-Known / Discovery

| Method | Path                         | Description               |
| ------ | ---------------------------- | ------------------------- |
| GET    | `/.well-known/webfinger`     | WebFinger resource lookup |
| GET    | `/.well-known/nodeinfo`      | NodeInfo discovery        |
| GET    | `/.well-known/host-meta`     | Host metadata (XML)       |
| GET    | `/nodeinfo/2.0`              | NodeInfo document         |

### OAuth

| Method | Path               | Description            |
| ------ | ------------------ | ---------------------- |
| GET    | `/oauth/authorize` | Authorization page     |
| POST   | `/oauth/token`     | Token exchange         |
| POST   | `/oauth/revoke`    | Token revocation       |

### Apps

| Method | Path               | Description                   |
| ------ | ------------------ | ----------------------------- |
| POST   | `/api/v1/apps`     | Register an OAuth application |

### Accounts

| Method | Path                                          | Description                    |
| ------ | --------------------------------------------- | ------------------------------ |
| POST   | `/api/v1/accounts`                            | Register a new account         |
| GET    | `/api/v1/accounts/verify_credentials`         | Current user profile           |
| PATCH  | `/api/v1/accounts/update_credentials`         | Update current user profile    |
| GET    | `/api/v1/accounts/lookup`                     | Lookup account by acct         |
| GET    | `/api/v1/accounts/search`                     | Search accounts                |
| GET    | `/api/v1/accounts/relationships`              | Relationship status with accounts |
| GET    | `/api/v1/accounts/:id`                        | Fetch account                  |
| GET    | `/api/v1/accounts/:id/statuses`               | Account statuses               |
| GET    | `/api/v1/accounts/:id/followers`              | Account followers              |
| GET    | `/api/v1/accounts/:id/following`              | Account following              |
| POST   | `/api/v1/accounts/:id/follow`                 | Follow account                 |
| POST   | `/api/v1/accounts/:id/unfollow`               | Unfollow account               |
| POST   | `/api/v1/accounts/:id/block`                  | Block account                  |
| POST   | `/api/v1/accounts/:id/unblock`                | Unblock account                |
| POST   | `/api/v1/accounts/:id/mute`                   | Mute account                   |
| POST   | `/api/v1/accounts/:id/unmute`                 | Unmute account                 |
| POST   | `/api/v1/accounts/change_password`            | Change password                |

### Auth

| Method | Path                          | Description            |
| ------ | ----------------------------- | ---------------------- |
| POST   | `/api/v1/auth/login`          | Direct login           |
| POST   | `/api/v1/auth/passwords`      | Password reset flow    |

### Statuses

| Method | Path                                        | Description               |
| ------ | ------------------------------------------- | ------------------------- |
| POST   | `/api/v1/statuses`                          | Create a status           |
| GET    | `/api/v1/statuses/:id`                      | Fetch a status            |
| PUT    | `/api/v1/statuses/:id`                      | Edit a status             |
| DELETE | `/api/v1/statuses/:id`                      | Delete a status           |
| GET    | `/api/v1/statuses/:id/context`              | Status context (thread)   |
| POST   | `/api/v1/statuses/:id/favourite`            | Favourite a status        |
| POST   | `/api/v1/statuses/:id/unfavourite`          | Unfavourite a status      |
| POST   | `/api/v1/statuses/:id/reblog`               | Boost a status            |
| POST   | `/api/v1/statuses/:id/unreblog`             | Unboost a status          |
| POST   | `/api/v1/statuses/:id/bookmark`             | Bookmark a status         |
| POST   | `/api/v1/statuses/:id/unbookmark`           | Unbookmark a status       |
| POST   | `/api/v1/statuses/:id/pin`                  | Pin a status              |
| POST   | `/api/v1/statuses/:id/unpin`                | Unpin a status            |
| POST   | `/api/v1/statuses/:id/mute`                 | Mute a conversation       |
| POST   | `/api/v1/statuses/:id/unmute`               | Unmute a conversation     |
| GET    | `/api/v1/statuses/:id/favourited_by`        | Who favourited            |
| GET    | `/api/v1/statuses/:id/reblogged_by`         | Who boosted               |
| PUT    | `/api/v1/statuses/:id/reactions/:name`      | Add emoji reaction        |
| DELETE | `/api/v1/statuses/:id/reactions/:name`      | Remove emoji reaction     |

### Timelines

| Method | Path                             | Description                   |
| ------ | -------------------------------- | ----------------------------- |
| GET    | `/api/v1/timelines/home`         | Home timeline                 |
| GET    | `/api/v1/timelines/public`       | Public (federated) timeline   |
| GET    | `/api/v1/timelines/tag/:hashtag` | Hashtag timeline              |
| GET    | `/api/v1/timelines/list/:id`     | List timeline                 |

### Notifications

| Method | Path                                 | Description              |
| ------ | ------------------------------------ | ------------------------ |
| GET    | `/api/v1/notifications`              | All notifications        |
| GET    | `/api/v1/notifications/:id`          | Single notification      |
| POST   | `/api/v1/notifications/clear`        | Clear all notifications  |
| POST   | `/api/v1/notifications/:id/dismiss`  | Dismiss one notification |

### Conversations

| Method | Path                                 | Description                |
| ------ | ------------------------------------ | -------------------------- |
| GET    | `/api/v1/conversations`              | List direct conversations  |
| DELETE | `/api/v1/conversations/:id`          | Delete a conversation      |
| POST   | `/api/v1/conversations/:id/read`     | Mark conversation read     |

### Lists

| Method | Path                                          | Description              |
| ------ | --------------------------------------------- | ------------------------ |
| GET    | `/api/v1/lists`                               | Get all lists            |
| GET    | `/api/v1/lists/:id`                           | Get a list               |
| POST   | `/api/v1/lists`                               | Create a list            |
| PUT    | `/api/v1/lists/:id`                           | Update a list            |
| DELETE | `/api/v1/lists/:id`                           | Delete a list            |
| GET    | `/api/v1/lists/:id/accounts`                  | List members             |
| POST   | `/api/v1/lists/:id/accounts`                  | Add members              |
| DELETE | `/api/v1/lists/:id/accounts`                  | Remove members           |

### Filters, Tags, Polls

| Method   | Path                        | Description              |
| -------- | --------------------------- | ------------------------ |
| GET      | `/api/v2/filters`           | Content filters          |
| GET      | `/api/v1/tags/:id`          | Followed tag info        |
| GET      | `/api/v1/polls/:id`         | Fetch a poll             |
| POST     | `/api/v1/polls/:id/votes`   | Vote on a poll           |

### Reports

| Method | Path              | Description     |
| ------ | ----------------- | --------------- |
| POST   | `/api/v1/reports` | File a report   |

### Other User Endpoints

| Method   | Path                         | Description              |
| -------- | ---------------------------- | ------------------------ |
| GET      | `/api/v1/favourites`         | Favourited statuses      |
| GET      | `/api/v1/bookmarks`          | Bookmarked statuses      |
| GET      | `/api/v1/blocks`             | Blocked accounts         |
| GET      | `/api/v1/mutes`              | Muted accounts           |
| GET      | `/api/v1/follow_requests`    | Pending follow requests  |
| GET      | `/api/v1/preferences`        | User preferences         |
| GET/POST | `/api/v1/markers`            | Timeline read markers    |
| GET      | `/api/v1/suggestions`        | Follow suggestions       |

### Search

| Method | Path             | Description                    |
| ------ | ---------------- | ------------------------------ |
| GET    | `/api/v2/search` | Full search (with WebFinger resolve) |

### Media

| Method | Path                             | Description               |
| ------ | -------------------------------- | ------------------------- |
| POST   | `/api/v2/media`                  | Upload media attachment   |
| GET    | `/api/v1/media/:id`              | Get media attachment      |
| PUT    | `/api/v1/media/:id`              | Update media description  |

### Push Subscription

| Method | Path                           | Description            |
| ------ | ------------------------------ | ---------------------- |
| GET    | `/api/v1/push/subscription`    | Get push subscription  |
| POST   | `/api/v1/push/subscription`    | Create subscription    |
| PUT    | `/api/v1/push/subscription`    | Update subscription    |
| DELETE | `/api/v1/push/subscription`    | Delete subscription    |

### Streaming

| Method | Path                    | Description         |
| ------ | ----------------------- | ------------------- |
| GET    | `/api/v1/streaming`     | WebSocket streaming |

### Instance

| Method | Path                          | Description              |
| ------ | ----------------------------- | ------------------------ |
| GET    | `/api/v1/instance`            | Instance info (v1)       |
| GET    | `/api/v1/instance/peers`      | Known peers              |
| GET    | `/api/v1/instance/activity`   | Instance activity stats  |
| GET    | `/api/v1/instance/rules`      | Server rules             |
| GET    | `/api/v2/instance`            | Extended instance info   |
| GET    | `/api/v1/custom_emojis`       | Custom emoji list        |
| GET    | `/api/v1/announcements`       | Server announcements     |

### Trends

| Method | Path                         | Description            |
| ------ | ---------------------------- | ---------------------- |
| GET    | `/api/v1/trends/tags`        | Trending hashtags      |
| GET    | `/api/v1/trends/statuses`    | Trending statuses      |

### Admin API

| Method | Path                                      | Description                |
| ------ | ----------------------------------------- | -------------------------- |
| GET    | `/api/v1/admin/accounts`                  | List accounts              |
| GET    | `/api/v1/admin/accounts/:id`              | Account detail             |
| POST   | `/api/v1/admin/accounts/:id/action`       | Moderate an account        |
| POST   | `/api/v1/admin/accounts/:id/approve`      | Approve pending account    |
| POST   | `/api/v1/admin/accounts/:id/reject`       | Reject pending account     |
| POST   | `/api/v1/admin/accounts/:id/role`         | Change account role        |
| GET    | `/api/v1/admin/reports`                   | List reports               |
| GET    | `/api/v1/admin/reports/:id`               | Get report detail          |
| POST   | `/api/v1/admin/reports/:id/resolve`       | Resolve a report           |
| POST   | `/api/v1/admin/reports/:id/assign_to_self`| Assign report              |
| GET    | `/api/v1/admin/domain_blocks`             | Domain blocks              |
| POST   | `/api/v1/admin/domain_blocks`             | Create domain block        |
| DELETE | `/api/v1/admin/domain_blocks/:id`         | Remove domain block        |
| GET    | `/api/v1/admin/domain_allows`             | Domain allows              |
| GET    | `/api/v1/admin/ip_blocks`                 | IP blocks                  |
| GET    | `/api/v1/admin/email_domain_blocks`       | Email domain blocks        |
| GET    | `/api/v1/admin/measures`                  | Instance metrics           |
| GET    | `/api/v1/admin/rules`                     | Server rules (admin)       |
| POST   | `/api/v1/admin/rules`                     | Create rule                |
| PUT    | `/api/v1/admin/rules/:id`                 | Update rule                |
| DELETE | `/api/v1/admin/rules/:id`                 | Delete rule                |
| GET    | `/api/v1/admin/settings`                  | Server settings            |
| PUT    | `/api/v1/admin/settings`                  | Update server settings     |
| GET    | `/api/v1/admin/announcements`             | Manage announcements       |
| POST   | `/api/v1/admin/announcements`             | Create announcement        |
| PUT    | `/api/v1/admin/announcements/:id`         | Update announcement        |
| DELETE | `/api/v1/admin/announcements/:id`         | Delete announcement        |
| GET    | `/api/v1/admin/custom_emojis`             | Manage custom emojis       |
| POST   | `/api/v1/admin/custom_emojis`             | Upload custom emoji        |
| GET    | `/api/v1/admin/relays`                    | Manage relays              |
| POST   | `/api/v1/admin/relays`                    | Add relay                  |
| DELETE | `/api/v1/admin/relays/:id`                | Remove relay               |
| GET    | `/api/v1/admin/federation`                | Federation status/stats    |
| POST   | `/api/v1/admin/email`                     | Send admin email           |

### ActivityPub (Server-to-Server)

| Method | Path                            | Description                  |
| ------ | ------------------------------- | ---------------------------- |
| GET    | `/users/:username`              | Actor profile (AS2 JSON-LD)  |
| POST   | `/users/:username/inbox`        | Personal inbox               |
| GET    | `/users/:username/outbox`       | Outbox collection            |
| GET    | `/users/:username/followers`    | Followers collection         |
| GET    | `/users/:username/following`    | Following collection         |
| GET    | `/users/:username/featured`     | Featured (pinned) collection |
| GET    | `/users/:username/featured_tags`| Featured tags                |
| GET    | `/actor`                        | Instance actor               |
| POST   | `/inbox`                        | Shared inbox                 |

### Health

| Method | Path       | Description  |
| ------ | ---------- | ------------ |
| GET    | `/healthz` | Health check |

---

## Federation Features

- **HTTP Signatures** (draft-cavage-http-signatures-12) -- RSA-SHA256 signing for all outbound requests
- **RFC 9421 double-knock** -- modern HTTP Message Signatures for delivery
- **Linked Data Signatures** -- signing and verification for relay forwarding
- **Object Integrity Proofs** (FEP-8b32) -- Ed25519 `ed25519-jcs-2022` cryptosuite, verification on inbound
- **Activity Forwarding** -- forwards activities to followers with original signature preservation
- **Collection Pagination** -- `OrderedCollection` / `OrderedCollectionPage` with `next`/`prev` links
- **Activity Idempotency** -- deduplication of incoming activities by ID
- **WebFinger resolution** -- resolves `acct:` URIs for remote account discovery
- **Instance Actor** -- `/actor` endpoint with its own RSA keypair for relay communication
- **Misskey extensions** -- `EmojiReact`, `_misskey_content`, `_misskey_quote`, quote posts

See [FEDERATION.md](../FEDERATION.md) for the full federation specification.

---

## Project Structure

```
src/
  index.ts                     # Hono app entry point, route mounting
  env.ts                       # Env type definitions (bindings + variables)
  endpoints/
    wellknown/                 # WebFinger, NodeInfo, host-meta
    oauth/                     # OAuth authorize, token, revoke
    media.ts                   # Media file serving
    api/
      v1/
        accounts/              # Account CRUD, follow, block, mute, search, lookup
        statuses/              # Status CRUD, favourite, reblog, bookmark, pin, mute, edit, reactions
        timelines/             # Home, public, hashtag, list timelines
        notifications/         # Notification list, fetch, dismiss, clear
        conversations/         # Conversations list, delete, read
        lists/                 # List CRUD and membership
        filters/               # Content filters
        polls/                 # Poll fetch and voting
        push/                  # Web Push subscription management
        trends/                # Trending tags and statuses
        admin/
          accounts/            # Admin account moderation (list, fetch, action, approve, reject, role)
          reports/             # Admin report handling (list, fetch, resolve, assign)
          domainBlocks.ts      # Domain block management
          domainAllows.ts      # Domain allow management
          ipBlocks.ts          # IP block management
          emailDomainBlocks.ts # Email domain block management
          rules.ts             # Server rules management
          settings.ts          # Instance settings management
          announcements.ts     # Announcement management
          customEmojis.ts      # Custom emoji management
          relays.ts            # Relay management
          federation.ts        # Federation status and stats
          measures.ts          # Instance metrics
          email.ts             # Admin email sending
        auth/                  # Login and password endpoints
        apps.ts                # OAuth app registration
        blocks.ts              # Blocked accounts list
        bookmarks.ts           # Bookmarked statuses
        favourites.ts          # Favourited statuses
        mutes.ts               # Muted accounts list
        followRequests.ts      # Follow request management
        markers.ts             # Timeline read markers
        preferences.ts         # User preferences
        reports.ts             # Report filing
        rules.ts               # Server rules (public)
        suggestions.ts         # Follow suggestions
        tags.ts                # Followed tags
        customEmojis.ts        # Custom emoji list
        announcements.ts       # Server announcements
        instance.ts            # Instance info (v1)
        streaming.ts           # WebSocket streaming
      v2/
        instance.ts            # Extended instance information
        search.ts              # Full-text search with WebFinger resolve
        media.ts               # Media upload
    activitypub/               # ActivityPub protocol handlers
      actor.ts                 # Actor profile endpoint
      inbox.ts                 # Personal inbox
      sharedInbox.ts           # Shared inbox
      outbox.ts                # Outbox collection
      followers.ts             # Followers collection
      following.ts             # Following collection
      featured.ts              # Featured (pinned) collection
      featuredTags.ts          # Featured tags collection
      instanceActor.ts         # Instance-level actor
  middleware/
    auth.ts                    # Bearer token authentication
    cors.ts                    # CORS headers
    contentNegotiation.ts      # Accept header handling (JSON vs AS2)
    errorHandler.ts            # Global error handler
    rateLimit.ts               # Rate limiting via KV
    requestId.ts               # Request ID generation
  repositories/                # Data access layer (D1 queries)
    account.ts                 # Account queries
    status.ts                  # Status queries
    follow.ts                  # Follow relationship queries
    notification.ts            # Notification queries
    user.ts                    # User/credential queries
    oauthApp.ts                # OAuth application queries
    oauthToken.ts              # OAuth token queries
    oauthCode.ts               # OAuth authorization code queries
    media.ts                   # Media attachment queries
    favourite.ts               # Favourite queries
    bookmark.ts                # Bookmark queries
    block.ts                   # Block queries
    mute.ts                    # Mute queries
    tag.ts                     # Tag queries
    mention.ts                 # Mention queries
    homeTimeline.ts            # Home timeline queries
    actorKey.ts                # Actor key management
    settings.ts                # Instance settings queries
    instance.ts                # Instance metadata queries
  federation/
    httpSignatures.ts          # HTTP Signature signing and verification
    ldSignatures.ts            # Linked Data Signatures
    integrityProofs.ts         # Object Integrity Proofs (Ed25519)
    activityBuilder.ts         # Activity construction helpers
    activityForwarder.ts       # Activity forwarding with signature preservation
    actorSerializer.ts         # Actor to AS2 JSON-LD serialization
    noteSerializer.ts          # Note to AS2 JSON-LD serialization
    deliveryManager.ts         # Federation delivery orchestration
    resolveRemoteAccount.ts    # Remote account resolution
    webfinger.ts               # WebFinger client
    inboxProcessors/           # ActivityPub inbox activity processors
      create.ts                # Create (Note)
      update.ts                # Update (Note, Actor)
      delete.ts                # Delete (Note, Actor)
      follow.ts                # Follow
      accept.ts                # Accept (Follow)
      reject.ts                # Reject (Follow)
      like.ts                  # Like (favourite)
      announce.ts              # Announce (boost)
      undo.ts                  # Undo (Follow, Like, Announce, Block)
      block.ts                 # Block
      move.ts                  # Move (account migration)
      flag.ts                  # Flag (report)
      emojiReact.ts            # EmojiReact (Misskey reactions)
  durableObjects/
    streaming.ts               # WebSocket streaming Durable Object
  webpush/                     # Web Push notification utilities
  utils/
    crypto.ts                  # Cryptographic utilities, key management
    mastodonSerializer.ts      # Entity serialization to Mastodon API format
    pagination.ts              # Link header pagination
    sanitize.ts                # HTML sanitization
    totp.ts                    # TOTP 2FA
    ulid.ts                    # ULID generation
    contentParser.ts           # Status content parsing (mentions, hashtags)
    idempotencyKey.ts          # Idempotency key handling
    statusEnrichment.ts        # Status enrichment (counts, relationships)
    defaultImages.ts           # Default avatar/header images
    reblogResolver.ts          # Reblog resolution utilities
  i18n/                        # Internationalization messages
  types/                       # Shared TypeScript types
```

---

## Configuration

### Environment Variables (`wrangler.jsonc` vars)

| Variable            | Description                      | Example            |
| ------------------- | -------------------------------- | ------------------ |
| `INSTANCE_DOMAIN`   | The domain your instance runs on | `siliconbeest.com` |
| `INSTANCE_TITLE`    | Display name of the instance     | `SiliconBeest`     |
| `REGISTRATION_MODE` | `open`, `approval`, or `closed`  | `open`             |

### Secrets (set via `wrangler secret put`)

| Secret              | Description                                |
| ------------------- | ------------------------------------------ |
| `VAPID_PRIVATE_KEY` | VAPID key for Web Push (base64url)         |
| `VAPID_PUBLIC_KEY`  | VAPID public key for Web Push (base64url)  |
| `OTP_ENCRYPTION_KEY`| Encryption key for TOTP 2FA secrets        |

---

## Local Development

```bash
npm install
npm run dev
```

This starts `wrangler dev` with local D1, R2, KV, and Queue emulation. The API will be available at `http://localhost:8787`.

Apply local migrations first:

```bash
npx wrangler d1 migrations apply siliconbeest-db --local
```

Generate Cloudflare binding types after changing `wrangler.jsonc`:

```bash
npm run cf-typegen
```

---

## Testing

The project uses [Vitest](https://vitest.dev/) with `@cloudflare/vitest-pool-workers` for integration testing against real Workers runtime APIs.

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

There are 48 test files covering endpoint behavior, repository logic, federation processing, HTTP signatures, LD signatures, integrity proofs, serializers, and utilities.

---

## How to Add New Endpoints

1. Create a new file under `src/endpoints/api/v1/` (or the appropriate version).
2. Define a Hono sub-app with your routes:

```typescript
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', async (c) => {
  // your handler logic
  return c.json({ result: 'ok' });
});

export default app;
```

3. Mount it in `src/index.ts`:

```typescript
import myEndpoint from './endpoints/api/v1/myEndpoint';
app.route('/api/v1/my_endpoint', myEndpoint);
```

4. Add tests in the `test/` directory.

---

## How to Add New Migrations

D1 migrations live in the `migrations/` directory. To add a new migration:

```bash
wrangler d1 migrations create siliconbeest-db my_migration_name
```

This creates a new numbered SQL file. Write your DDL/DML statements, then apply:

```bash
# Local
wrangler d1 migrations apply siliconbeest-db --local

# Remote
wrangler d1 migrations apply siliconbeest-db --remote
```

---

## Mastodon API Compatibility Notes

- The API targets Mastodon API v4.x compatibility. Most GET/POST endpoints behave identically to Mastodon.
- Pagination uses `Link` headers with `max_id`, `since_id`, and `min_id` parameters, matching Mastodon conventions.
- Entity shapes (Account, Status, Notification, etc.) follow the Mastodon entity schema.
- Some endpoints that depend on Mastodon-specific features (e.g., Elasticsearch full-text search) have simplified implementations backed by D1 SQL queries.
- Streaming uses the same WebSocket protocol as Mastodon (`wss://domain/api/v1/streaming`).
- Media uploads support the same multipart form data format.
- Emoji reactions use Misskey-compatible `EmojiReact` activity type.
