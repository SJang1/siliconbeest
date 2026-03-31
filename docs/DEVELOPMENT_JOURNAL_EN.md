# SiliconBeest Development Journal

> This document is a chronological record of problems discovered, decisions made, and lessons learned during the development of SiliconBeest.
> It covers the intensive development period from March 23 to 24, 2026.
>
> **Note:** This journal references the old split architecture (`siliconbeest-worker/` + `siliconbeest-vue/`). These have since been merged into `siliconbeest/`.

---

## 1. How the Project Started

### Why We Built This
- Cloudflare's **Wildebeest** project was discontinued (https://github.com/cloudflare/wildebeest)
- The idea behind Wildebeest (a serverless Fediverse server) was great, but it no longer works
- We decided to reimplement it using Cloudflare Workers' current capabilities (D1, R2, KV, Queues, Durable Objects)

### Core Design Principles
1. **Stay within Cloudflare Paid Plan limits** — No expensive add-ons like Containers
2. **Mastodon API compatibility** — Usable with third-party apps (Ivory, Ice Cubes, Tusky, etc.)
3. **ActivityPub standard compliance** — Federate with Mastodon, Misskey, Pleroma, and others
4. **TypeScript throughout** — Minimize JavaScript usage
5. **Scalable architecture** — Handle growth from a handful of users to large-scale deployments

### References
- Wildebeest README: https://raw.githubusercontent.com/cloudflare/wildebeest/refs/heads/main/README.md
- ActivityPub W3C Spec: https://www.w3.org/TR/activitypub/
- Misskey source code: https://github.com/misskey-dev/misskey
- Cloudflare Workers docs: https://developers.cloudflare.com/workers/
- Fedify (TypeScript AP framework): https://github.com/fedify-dev/fedify

---

## 2. Architecture Decisions

### Why We Chose a 3-Worker Architecture
We could have started with a single Worker, but split into three for separation of concerns:

| Worker | Role | Rationale |
|--------|------|-----------|
| `siliconbeest-worker` | API + ActivityPub | Main logic, handles requests and responses |
| `siliconbeest-queue-consumer` | Async tasks | Offloads CPU-intensive work: federation delivery, media processing, notifications |
| `siliconbeest-vue` | Frontend SPA | Vue 3 + Vite, served in SPA mode |

**Why separate the Queue Consumer**: Cloudflare Workers have per-request CPU time limits. Operations like HTTP Signature computation, RSA/Ed25519 signing, and remote server fetches are CPU-heavy, so they're handled asynchronously via Queues.

### Rationale for Cloudflare Service Choices

| Service | Purpose | Alternatives Considered |
|---------|---------|------------------------|
| **D1** | Relational data (accounts, posts, follows, etc.) | Considered Hyperdrive + external PG, but D1 is more cost-effective |
| **R2** | Media file storage | S3-compatible, well-suited for images/videos |
| **KV** | Cache + sessions | WebFinger cache, token cache, rate limiting, etc. |
| **Queues** | Async tasks | Synchronous federation delivery would cause response delays |
| **Durable Objects** | WebSocket streaming | Needed for per-user WebSocket connection management |

### ID Strategy: ULID
- Chose ULID (Universally Unique Lexicographically Sortable Identifier) over UUID
- Enables chronological sorting via `ORDER BY id DESC`
- **Problem discovered**: Local posts (`00MN...`) and remote posts (`01KM...`) use different ULID generators, so `ORDER BY id` doesn't produce chronological order
- **Fix**: Switched to `ORDER BY created_at DESC` for timelines

### Routing Structure
Cloudflare Workers Routes distribute requests by path:
```
siliconbeest.sjang.dev/api/*          → siliconbeest-worker
siliconbeest.sjang.dev/oauth/*        → siliconbeest-worker
siliconbeest.sjang.dev/.well-known/*  → siliconbeest-worker
siliconbeest.sjang.dev/users/*        → siliconbeest-worker
siliconbeest.sjang.dev/inbox          → siliconbeest-worker
siliconbeest.sjang.dev/media/*        → siliconbeest-worker
siliconbeest.sjang.dev/actor          → siliconbeest-worker
siliconbeest.sjang.dev (catch-all)    → siliconbeest-vue (SPA)
```

**Heads up**: `zone_name`-based routing passes through Cloudflare WAF/Bot Protection first. The `/users/*` path was getting blocked with 403 by Bot Fight Mode — we had to add a WAF Skip rule.

---

## 3. Lessons from Implementing ActivityPub

### HTTP Signatures — The Hardest Part

#### Draft-Cavage vs RFC 9421
- **Draft-Cavage** (legacy): Used by most existing Fediverse servers
- **RFC 9421** (new): The standardized approach, supported by Fedify and others
- **Solution: Double-Knock Strategy**
  1. Check cached preference (KV key `sig-pref:{domain}`)
  2. If no preference, try RFC 9421 first
  3. If 401/403 response, retry with Draft-Cavage
  4. Cache the successful method for 7 days

#### Why Signed Fetch Is Necessary
- Misskey-family servers (kokonect.link, serafuku.moe, etc.) require HTTP Signatures even for fetching actor documents
- A plain `fetch()` returns 401
- Must sign requests with the **Instance Actor** (`/actor`) RSA key
- Added signed fetch logic to the `fetchRemoteActor()` function

#### Content-Digest Formats
- RFC 9530 format: `sha-256=:BASE64:` (wrapped with colons)
- Draft-Cavage format: `SHA-256=BASE64` (no colons)
- Different servers expect different formats, so we handle both

### Object Integrity Proofs (FEP-8b32)
- Ed25519 key generation + Base58btc + Multicodec (`0xed01` prefix)
- Requires JCS (JSON Canonicalization Scheme, RFC 8785) implementation
- Proof chain: SHA-256(proof_options) + SHA-256(document) → Ed25519 signature → Base58btc

#### Bug Found: LD Signature Ordering Issue
`createProof()` was adding `data-integrity/v1` to `@context` → LD Signature was being computed against a modified document, but the operations were in the wrong order. **Fix: Generate the Integrity Proof first, then create the LD Signature.**

### WebFinger
```
GET /.well-known/webfinger?resource=acct:user@domain
```
- Response includes 3 links: `self` (AP actor), `profile-page`, `subscribe` (OStatus template)
- Instance Actor needs WebFinger support too — some servers validate the Instance Actor via WebFinger

#### Instance Actor's preferredUsername Problem
- Initially set `preferredUsername` to the full domain (`siliconbeest.sjang.dev`)
- Remote servers would look up `acct:siliconbeest.sjang.dev@siliconbeest.sjang.dev` via WebFinger → failed
- **Fix**: Keep `preferredUsername` as `siliconbeest.sjang.dev`, but map that username to the instance actor in WebFinger responses

### Conversation Threading
- There's no official `conversation` field in the AP spec, but it's a de facto standard used by Mastodon
- Format: `tag:server,year:objectId=123:objectType=Conversation`
- **Initial implementation**: Managed `conversation_id` locally only, ignored the `conversation` field on remote posts
- **Problem**: Posts in the same thread ended up with different conversations → replies didn't appear in context
- **Fix**: Read the `conversation` field from inbound Notes and store it in the DB's `ap_uri` column for matching

### Activity Forwarding
- Forward activities addressed to a remote user's follower collection to followers on other servers
- **Must preserve the original HTTP Signature** — re-signing would break it
- Store the original body + headers as-is in the Queue message for forwarding

### Visibility
| Visibility | AP Addressing | Home | Local | Federated |
|------------|--------------|:----:|:-----:|:---------:|
| Public | `to: [Public], cc: [followers]` | Yes | Yes | Yes |
| Unlisted | `to: [followers], cc: [Public]` | Yes | No | No |
| Private | `to: [followers]` | Yes | No | No |
| Direct | `to: [mentioned users]` | No | No | No |

**Followers-only posts cannot be reblogged** — doing so would undermine the intended restricted visibility defined by the AP spec.

---

## 4. Lessons from Mastodon API Compatibility

### Requirements for Third-Party App Compatibility

1. **Keep `version` field at `4.0.0`**
   - Third-party apps parse the version to determine feature support
   - Use the format `4.0.0 (compatible; SiliconBeest 0.1.0)`
   - Pleroma uses a similar pattern: `2.4.2 (compatible; Pleroma 2.6.0)`

2. **`/api/v1/instance` endpoint is mandatory**
   - We initially only implemented v2, but third-party apps call v1 first
   - Missing v1 causes authentication failures

3. **`avatar_static` and `header_static` must not be `null` — apps crash**
   - Mastodon always returns a URL (falls back to the original URL when no static version exists)
   - Must fall back to the original URL instead of returning `null`

4. **`filtered` field is required**
   - Must be included even if it's `[]` (empty array)
   - Some apps throw parsing errors if it's missing

5. **`created_at` must include milliseconds**
   - Mastodon: `2026-03-24T11:38:40.344Z`
   - Ours: `2026-03-24T10:25:52Z` (no milliseconds)
   - Added `ensureISO8601WithMs()` to always produce the `.000Z` format

6. **`group_key` field** (Mastodon 4.3+)
   - Used for notification grouping
   - Format: `{type}-{status_id}-{account_id}`
   - Falls back to `ungrouped-{id}` if not implemented

### OAuth Flow
- Authorization Code + PKCE (S256/plain) support
- Client Credentials support
- 2FA/TOTP: Compatible with Google Authenticator and similar apps
- **Bug found**: DB schema column name mismatches
  - `oauth_access_tokens`: `resource_owner_id` vs `user_id`
  - `oauth_authorization_codes`: `token` vs `code`
  - Caught and fixed during testing

### Streaming API
- Mastodon-compatible WebSocket Streaming API
- `GET /api/v1/streaming?stream=user&access_token=TOKEN`
- Durable Objects manage per-user WebSocket connections
- Uses the **WebSocket Hibernation API** for cost savings (DO releases memory when idle)
- **Issue found**: Initially implemented without hibernation → reimplemented using `this.ctx.acceptWebSocket()` + `webSocketMessage()` pattern per Cloudflare's official docs

### URL Preview Cards
- Detect URLs when a post is created → fetch OpenGraph metadata via Queue
- `preview_cards` + `status_preview_cards` tables
- OG parsing: `og:title`, `og:description`, `og:image`, with fallback to `<title>` and `<meta name="description">`
- Fallback handling when image loading fails (e.g., SVGs)

---

## 5. Misskey Compatibility

### Emoji Reactions
- Mastodon only supports favourites (likes)
- Misskey supports custom emoji reactions
- AP format: `Like` activity with an added `_misskey_reaction` field
- Or a separate `EmojiReact` activity type
- **Bidirectional implementation**:
  - Inbound: If a `Like` has `_misskey_reaction`, store it in the emoji_reactions table
  - Outbound: `buildEmojiReactActivity()` sends Like + `_misskey_reaction` + `content`

### Custom Emoji Federation
- AP Note/Actor `tag` array includes `{ type: "Emoji", name: ":shortcode:", icon: { url: "..." } }`
- **Problem found**: When saving emojis, the `domain` was being set to the image CDN host (`cdn01.kurry.gallery`)
- **Fix**: Extract the server domain from the actor document's `id` field
- **Bulk reprocessing**: Deleted all incorrectly saved emojis, re-fetched AP Notes/Actors, and re-saved with the correct domain

### Misskey Content Fields
- `_misskey_content`: Original MFM (Misskey Flavored Markdown) text
- `_misskey_summary`: CW (Content Warning) text
- `_misskey_quote`: Quoted post URI
- Falls back to `_misskey_content` when inbound `content` is empty

---

## 6. Lessons from Frontend Development

### vue-i18n `SyntaxError: 10`
- The most frustrating error we encountered
- vue-i18n throws parsing errors on special characters (`|`, `{`, `}`, etc.) during message compilation
- `|` is used as a pluralization separator in vue-i18n
- **Fix**: Escape special characters or wrap them in `{'|'}` syntax

### Page Navigation Fails After Router Hash Changes
- When code changes alter the build hash, existing chunks return 404
- **Fix**: Catch `NavigationFailure` in Vue Router → force a full page reload with `window.location.href`

### Mobile Navigation
- Desktop: Left sidebar (always visible)
- Mobile: Bottom tab bar (5 items) + hamburger menu (more options)
- **Missing feature discovered**: Search and About pages were inaccessible on mobile → added them to the More menu

### Emoji Picker Positioning Issue
- Opening the emoji picker from the Composer's bottom toolbar covered the composer, blocking input
- `absolute bottom-full` pushed it outside the viewport
- **Fix**: `<Teleport to="body">` + `fixed` positioning + calculate position relative to the button in JS

### Theming (Dark/Light)
- `useUiStore` with `setTheme()`
- `document.documentElement.classList.add/remove('dark')`
- Leverages Tailwind's `dark:` variant
- Persisted in localStorage

---

## 7. Bug Fix Log (Chronological)

### Phase 1-2: Build Stage
- Missing `CryptoKeyPair` type cast → added `as CryptoKeyPair`
- `lookbehind` regex not supported in Workers runtime → replaced with non-capturing group
- `spoiler_text` vs `content_warning` column name mismatch (4 locations)
- `fr.fr.id` double prefix — `buildPaginationQuery` was applying `.replace()` to already-qualified column names → removed the replace

### Federation Bugs
- **ReadableStream is locked**: Inbox handler tried to read the request body twice → read once with `const rawBody = await request.text()` and reuse
- **Follow requests not being processed**: `processFollow` failed to look up local accounts → fixed username extraction logic
- **Images not included in AP delivery**: `serializeNote()` was missing the `attachments` parameter in 4 call sites → fetch from DB and pass through
- **Timezone issue**: Some servers send timestamps with `+09:00` offsets → breaks SQLite string comparison ordering → added `normalizeToUTC()` to normalize all inbound timestamps to UTC

### Frontend Bugs
- **Login form not appearing**: Had `console.log` but no actual API call → connected auth store's `login()` method
- **New post button misbehaving**: Auto-insert at scroll top caused the button to disappear → redesigned scroll-position-based logic
- **Reblog showing empty card**: Streaming payload had `reblog: null` hardcoded → fetch the original post from DB and include it
- **Deleted replies not disappearing**: StatusDetailView wasn't handling the delete event → remove from the descendants array

---

## 8. Performance Optimization

### Batch Processing
- `enrichStatuses()`: Fetches media, like/boost/bookmark status, and emojis in **a single batch query**
- Instead of 5-6 queries per status, batches by status ID list with `WHERE id IN (...)`

### KV Cache Strategy
| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `token:{sha256}` | 5 min | OAuth token validation |
| `remote_actor:{uri}` | 5 min | Remote actor document |
| `webfinger:{acct}` | 5 min | WebFinger results |
| `sig-pref:{domain}` | 7 days | HTTP Signature preference |
| `activity-seen:{id}` | 24 hours | Prevent duplicate activity processing |
| `og:{url}` | 24 hours | URL preview card |
| `rl:{ip}:{endpoint}:{window}` | 5 min | Rate limiting |

### Smart Placement
- Set `placement: { mode: "smart" }` on the Worker
- Cloudflare places the Worker in the optimal datacenter based on request patterns
- Runs closer to D1, reducing latency

---

## 9. Operational Discoveries

### Cloudflare Bot Fight Mode Issue
- AP requests to `/users/*` were being blocked with 403
- Cause: Cloudflare Bot Fight Mode was flagging standard HTTP clients (curl, Mastodon servers) as bots
- **Fix**: Added WAF Skip rules for `/users/*`, `/inbox`, and `/actor` paths

### D1 Migration Management
- 17 migrations from `0001_initial_schema.sql` through `0016_account_migration.sql`
- Uses `wrangler d1 migrations apply`
- **Important**: D1 migrations are irreversible (no rollback)
- Test helpers must maintain the same schema → `applyMigration()` function

### SMTP Email Delivery
- Uses the `worker-mailer` package (an SMTP client built for Cloudflare Workers)
- Gmail SMTP: `smtp.gmail.com:587`, `plain` auth
- **Issues found**:
  - `auto` authType doesn't work with all servers → explicitly specify `['login', 'plain', 'cram-md5']` array
  - SMTP username wasn't being saved to DB → unified key name to `smtp_user`

### Never Change the Domain
- Changing the domain after launch invalidates all AP URIs
- Actor URIs and status URIs stored on other servers all break
- **Added a warning to the README**: "Do not change INSTANCE_DOMAIN after launch"

---

## 10. Testing Strategy

### Test Environment
- Vitest + `@cloudflare/vitest-pool-workers`
- D1, KV, and R2 emulated locally
- `applyMigration()`: Creates all tables + indexes + seed data
- `createTestUser()`: Creates account, user, actor_keys, and OAuth token in one call

### Test Categories
| Category | Files | Tests | Examples |
|----------|:-----:|:-----:|---------|
| API Endpoints | 25+ | 400+ | auth, statuses, timelines, notifications |
| Federation/AP | 10+ | 150+ | HTTP signatures, integrity proofs, LD signatures |
| Utilities | 8+ | 100+ | pagination, sanitize, ULID, content parser |
| Vue Frontend | 11 | 110+ | stores, components, router guards |

### Key Takeaways
- **Test schema and production schema must stay in sync** — the CREATE TABLE statements in `test/helpers.ts` diverged from the actual migrations multiple times, causing tests to pass while production failed
- **Adding a column requires changes in 3 places**: migration SQL, `types/db.ts` types, and `test/helpers.ts` schema

---

## 11. Deployment Process

### Initial Setup
```bash
./scripts/setup.sh          # Interactive — configure domain, title, admin
./scripts/deploy.sh         # Deploy all 3 Workers
./scripts/configure-domain.sh siliconbeest.sjang.dev  # Custom domain routes
```

### Update Deployment
```bash
git pull
./scripts/update.sh         # Type check + migrations + deploy
```

### Environment Sync
```bash
./scripts/sync-config.sh           # Dry run — check current state
./scripts/sync-config.sh --apply   # Regenerate wrangler.jsonc
```

### Customizing Resource Names
- Change `PROJECT_PREFIX` in `config.sh` to rename all resources
- D1, R2, KV, and Queue names update automatically

---

## 12. Future Work

### Known Limitations
1. **D1 query limits**: Complex JOINs may become slow
2. **Workers CPU time**: Heavy tasks are offloaded to Queues, but there are still limits
3. **R2 image transformation**: Thumbnail generation not implemented (considering Cloudflare Images)
4. **Search**: Currently LIKE-based — no full-text search support
5. **Polls**: Basic structure exists, but real-time updates are not implemented

### Improvement Directions
1. Cloudflare Images integration for image resizing/optimization
2. Full-text search (D1's FTS5 or an external service)
3. Better video/audio media support
4. Support for more FEPs (Fediverse Enhancement Proposals)
5. Performance monitoring + alerting (expanded Sentry integration)

---

## 13. Tech Stack Summary

| Area | Technology |
|------|-----------|
| **Runtime** | Cloudflare Workers |
| **Language** | TypeScript |
| **Framework** | Hono (API), Vue 3 (Frontend) |
| **Database** | Cloudflare D1 (SQLite) |
| **Storage** | Cloudflare R2 |
| **Cache** | Cloudflare KV |
| **Queue** | Cloudflare Queues |
| **WebSocket** | Cloudflare Durable Objects |
| **Frontend Build** | Vite |
| **Styling** | Tailwind CSS 4 |
| **State Management** | Pinia |
| **i18n** | vue-i18n |
| **Testing** | Vitest |
| **Email** | worker-mailer |
| **Monitoring** | Sentry (optional) |
| **Cryptography** | Web Crypto API (RSA, Ed25519, AES-GCM, ECDSA) |

---

## 14. Key Lessons Summary

1. **With ActivityPub, implementation matters more than the spec** — Real-world servers often behave differently from the spec. Mastodon is the de facto standard.
2. **Column name mismatches are deadly** — Discrepancies between code and DB schema were the single biggest source of bugs.
3. **null vs empty string vs undefined** — Getting these exactly right in API responses is critical to preventing third-party app crashes.
4. **Signed Fetch is not optional** — Communicating with Misskey-family servers requires HTTP Signatures on all outbound fetches.
5. **Queue-based async processing** — Handling federation delivery synchronously destroys the user experience.
6. **Keep test schemas in sync** — Production migrations and test helper schemas must always match.
7. **Cloudflare's security features can interfere with AP** — Bot Fight Mode, WAF rules, and similar features can block server-to-server communication.
8. **i18n from day one** — Adding it later means reworking every component.
9. **Never change your domain** — AP URIs are permanent, so changing the domain is effectively a service restart from scratch.
10. **You have to handle other servers' bugs too** — Even when remote servers send malformed timestamps or incorrect content-types, you need to handle them gracefully.
