# SiliconBeest Worker

The API server for SiliconBeest. Built with [Hono](https://hono.dev/) on Cloudflare Workers, it implements the Mastodon API (v1 and v2) and the ActivityPub server-to-server protocol.

> Version **0.1.0**

---

## What It Does

- Serves the full Mastodon-compatible REST API so existing clients (Ivory, Ice Cubes, etc.) work out of the box.
- Handles ActivityPub federation -- receiving and sending activities to/from remote servers.
- Manages OAuth 2.0 authorization flows and TOTP two-factor authentication.
- Provides an admin API for instance management.
- Exposes WebSocket streaming through a Durable Object.
- Enqueues async jobs (federation delivery, notifications, media processing) to Cloudflare Queues.

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

### Accounts

| Method | Path                                         | Description                   |
| ------ | -------------------------------------------- | ----------------------------- |
| POST   | `/api/v1/apps`                               | Register an OAuth application |
| POST   | `/api/v1/accounts`                           | Register a new account        |
| GET    | `/api/v1/accounts/verify_credentials`        | Current user profile          |
| GET    | `/api/v1/accounts/:id`                       | Fetch account                 |
| GET    | `/api/v1/accounts/:id/statuses`              | Account statuses              |
| GET    | `/api/v1/accounts/:id/followers`             | Account followers             |
| GET    | `/api/v1/accounts/:id/following`             | Account following             |
| POST   | `/api/v1/accounts/:id/follow`                | Follow account                |
| POST   | `/api/v1/accounts/:id/unfollow`              | Unfollow account              |
| POST   | `/api/v1/accounts/:id/block`                 | Block account                 |
| POST   | `/api/v1/accounts/:id/unblock`               | Unblock account               |
| POST   | `/api/v1/accounts/:id/mute`                  | Mute account                  |
| POST   | `/api/v1/accounts/:id/unmute`                | Unmute account                |

### Statuses

| Method | Path                                    | Description               |
| ------ | --------------------------------------- | ------------------------- |
| POST   | `/api/v1/statuses`                      | Create a status           |
| GET    | `/api/v1/statuses/:id`                  | Fetch a status            |
| DELETE | `/api/v1/statuses/:id`                  | Delete a status           |
| GET    | `/api/v1/statuses/:id/context`          | Status context (thread)   |
| POST   | `/api/v1/statuses/:id/favourite`        | Favourite a status        |
| POST   | `/api/v1/statuses/:id/unfavourite`      | Unfavourite a status      |
| POST   | `/api/v1/statuses/:id/reblog`           | Boost a status            |
| POST   | `/api/v1/statuses/:id/unreblog`         | Unboost a status          |
| POST   | `/api/v1/statuses/:id/bookmark`         | Bookmark a status         |
| POST   | `/api/v1/statuses/:id/unbookmark`       | Unbookmark a status       |

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

### Other v1 Endpoints

| Method   | Path                         | Description            |
| -------- | ---------------------------- | ---------------------- |
| GET      | `/api/v1/favourites`         | Favourited statuses    |
| GET      | `/api/v1/bookmarks`          | Bookmarked statuses    |
| GET      | `/api/v1/blocks`             | Blocked accounts       |
| GET      | `/api/v1/mutes`              | Muted accounts         |
| GET      | `/api/v1/preferences`        | User preferences       |
| GET      | `/api/v1/custom_emojis`      | Custom emoji list      |
| GET/POST | `/api/v1/markers`            | Timeline read markers  |
| GET      | `/api/v1/streaming`          | WebSocket streaming    |
| POST     | `/api/v1/push/subscription`  | Web Push subscription  |
| POST     | `/api/v1/reports`            | File a report          |
| GET      | `/api/v1/polls/:id`          | Fetch a poll           |
| POST     | `/api/v1/polls/:id/votes`    | Vote on a poll         |
| GET      | `/api/v1/conversations`      | Direct conversations   |
| GET      | `/api/v1/follow_requests`    | Pending follow requests|
| GET      | `/api/v1/lists`              | User lists             |
| GET      | `/api/v1/tags/:id`           | Followed tag info      |
| GET      | `/api/v1/suggestions`        | Follow suggestions     |
| GET      | `/api/v1/announcements`      | Server announcements   |
| GET      | `/api/v1/instance/rules`     | Server rules           |

### v2 Endpoints

| Method | Path               | Description             |
| ------ | ------------------ | ----------------------- |
| GET    | `/api/v2/instance` | Extended instance info  |
| GET    | `/api/v2/search`   | Full-text search        |
| POST   | `/api/v2/media`    | Upload media attachment |
| GET    | `/api/v2/filters`  | Content filters         |

### Admin API

| Method | Path                                      | Description            |
| ------ | ----------------------------------------- | ---------------------- |
| GET    | `/api/v1/admin/accounts`                  | List accounts          |
| GET    | `/api/v1/admin/accounts/:id`              | Account detail         |
| POST   | `/api/v1/admin/accounts/:id/action`       | Moderate an account    |
| GET    | `/api/v1/admin/reports`                   | List reports           |
| POST   | `/api/v1/admin/reports/:id/resolve`       | Resolve a report       |
| GET    | `/api/v1/admin/domain_blocks`             | Domain blocks          |
| GET    | `/api/v1/admin/domain_allows`             | Domain allows          |
| GET    | `/api/v1/admin/ip_blocks`                 | IP blocks              |
| GET    | `/api/v1/admin/email_domain_blocks`       | Email domain blocks    |
| GET    | `/api/v1/admin/measures`                  | Instance metrics       |
| GET    | `/api/v1/admin/rules`                     | Server rules (admin)   |
| GET    | `/api/v1/admin/settings`                  | Server settings        |
| GET    | `/api/v1/admin/announcements`             | Manage announcements   |

### ActivityPub (Server-to-Server)

| Method | Path                         | Description                  |
| ------ | ---------------------------- | ---------------------------- |
| GET    | `/users/:username`           | Actor profile (AS2 JSON-LD)  |
| POST   | `/users/:username/inbox`     | Personal inbox               |
| GET    | `/users/:username/outbox`    | Outbox collection            |
| GET    | `/users/:username/followers` | Followers collection         |
| GET    | `/users/:username/following` | Following collection         |
| POST   | `/inbox`                     | Shared inbox                 |

### Health

| Method | Path       | Description  |
| ------ | ---------- | ------------ |
| GET    | `/healthz` | Health check |

---

## Project Structure

```
src/
  index.ts                  # Hono app entry point, route mounting
  env.ts                    # Env type definitions (bindings + variables)
  endpoints/
    wellknown/              # WebFinger, NodeInfo, host-meta
    oauth/                  # OAuth authorize, token, revoke
    api/
      v1/
        accounts/           # Account CRUD, follow, block, mute
        statuses/           # Status CRUD, favourite, reblog, bookmark
        timelines/          # Home, public, hashtag, list timelines
        notifications/      # Notification list, dismiss, clear
        admin/              # Admin account/report/domain management
          accounts/         # Admin account moderation
          reports/          # Admin report handling
        push/               # Web Push subscription management
        polls/              # Poll fetch and voting
        conversations/      # Direct message conversations
        lists/              # User lists
        filters/            # Content filters
        trends/             # Trending content
      v2/
        instance.ts         # Extended instance information
        search.ts           # Full-text search
        media.ts            # Media upload
    activitypub/            # ActivityPub protocol handlers
      actor.ts              # Actor profile endpoint
      inbox.ts              # Personal inbox
      sharedInbox.ts        # Shared inbox
      outbox.ts             # Outbox collection
      followers.ts          # Followers collection
      following.ts          # Following collection
  middleware/
    auth.ts                 # Bearer token authentication
    cors.ts                 # CORS headers
    contentNegotiation.ts   # Accept header handling (JSON vs AS2)
    errorHandler.ts         # Global error handler
    rateLimit.ts            # Rate limiting
    requestId.ts            # Request ID generation
  repositories/             # Data access layer (D1 queries)
    account.ts              # Account queries
    status.ts               # Status queries
    follow.ts               # Follow relationship queries
    notification.ts         # Notification queries
    user.ts                 # User/credential queries
    oauthApp.ts             # OAuth application queries
    oauthToken.ts           # OAuth token queries
    oauthCode.ts            # OAuth authorization code queries
    media.ts                # Media attachment queries
    ...
  federation/
    inboxProcessors/        # ActivityPub inbox activity processors
  durableObjects/
    streaming.ts            # WebSocket streaming Durable Object
  webpush/                  # Web Push notification utilities
  utils/
    crypto.ts               # HTTP Signatures, key management
    mastodonSerializer.ts   # Entity serialization to Mastodon API format
    pagination.ts           # Link header pagination
    sanitize.ts             # HTML sanitization
    totp.ts                 # TOTP 2FA
    ulid.ts                 # ULID generation
    contentParser.ts        # Status content parsing (mentions, hashtags)
    idempotencyKey.ts       # Idempotency key handling
  i18n/                     # Internationalization messages
  types/                    # Shared TypeScript types
```

---

## Configuration

### Environment Variables (`wrangler.jsonc` vars)

| Variable            | Description                      | Example            |
| ------------------- | -------------------------------- | ------------------ |
| `INSTANCE_DOMAIN`   | The domain your instance runs on | `siliconbeest.com` |
| `INSTANCE_TITLE`    | Display name of the instance     | `Siliconbeest`     |
| `REGISTRATION_MODE` | `open`, `approval`, or `closed`  | `open`             |

### Secrets (set via `wrangler secret put`)

| Secret              | Description                                |
| ------------------- | ------------------------------------------ |
| `VAPID_PRIVATE_KEY` | VAPID key for Web Push (base64url)         |
| `VAPID_PUBLIC_KEY`  | VAPID public key for Web Push (base64url)  |
| `ADMIN_SECRET_KEY`  | Secret key for initial admin account setup |

---

## Local Development

```bash
npm install
npm run dev
```

This starts `wrangler dev` with local D1, R2, KV, and Queue emulation. The API will be available at `http://localhost:8787`.

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

There are currently 155 test files covering endpoint behavior, repository logic, and federation processing.

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

4. Add tests in the corresponding test directory.

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
