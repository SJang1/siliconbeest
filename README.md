# SiliconBeest

**Serverless Fediverse platform on Cloudflare Workers.**

SiliconBeest is a fully-featured [Mastodon API](https://docs.joinmastodon.org/api/)-compatible social networking server built entirely on the Cloudflare developer platform. It federates with the wider Fediverse via [ActivityPub](https://www.w3.org/TR/activitypub/) and can be deployed to a global edge network with zero traditional server infrastructure.

> **Warning: Do not change your instance domain after federating.** ActivityPub actor URIs contain the domain and are permanent identifiers across the Fediverse. Changing the domain after other servers have cached your actors will break all existing federation relationships, followers, and conversations. Choose your domain carefully before launch.

---

## Features

### Mastodon API Compatibility
- **Full Mastodon API v1/v2** -- works with existing clients (Tusky, Elk, Ice Cubes, Ivory, Mona, etc.)
- Accounts, statuses, timelines, notifications, conversations, lists, filters, polls, tags, bookmarks, favourites, search
- Admin API for moderation (accounts, reports, domain blocks, domain allows, IP blocks, email domain blocks, rules, settings, announcements, custom emojis, relays, measures)

### Federation (powered by Fedify)
- **[Fedify](https://fedify.dev/) v2.1.0** -- TypeScript ActivityPub framework handling the protocol layer (signatures, WebFinger, NodeInfo, delivery)
- **[`@fedify/cfworkers`](https://github.com/dahlia/fedify-cfworkers)** -- Cloudflare Workers adapter (KV store + Queue message dispatcher)
- **ActivityPub** server-to-server protocol
- **HTTP Signatures** (draft-cavage-http-signatures-12) -- RSA-SHA256 signing, handled by Fedify
- **RFC 9421 double-knock** -- modern HTTP Message Signatures for delivery, handled by Fedify
- **Linked Data Signatures** -- signing and verification for relay forwarding
- **Ed25519 Object Integrity Proofs** (FEP-8b32) -- `ed25519-jcs-2022` cryptosuite
- **Activity forwarding** with original signature preservation
- **Collection pagination** (OrderedCollection / OrderedCollectionPage)
- **Activity idempotency** -- deduplication of incoming activities
- **Instance actor** for relay and instance-level activities

### Interoperability
- **Misskey extensions** -- emoji reactions (`EmojiReact`), `_misskey_content`, `_misskey_quote`
- **FEP-8b32** -- Object Integrity Proofs (Ed25519)
- **FEP-8fcf** -- Followers Collection Synchronization
- **FEP-67ff** -- FEDERATION.md
- **FEP-e232** -- Quote Posts (`quoteUri`)
- **Featured collections** (pinned posts) via `Add`/`Remove`
- **Custom emoji** (local and remote)
- **Relay support** (admin-managed subscriptions)

### Authentication and Security
- **OAuth 2.0 + PKCE** -- standards-compliant authorization flows with scope enforcement
- **TOTP two-factor authentication** (RFC 6238)
- **WebAuthn / Passkeys** -- passwordless authentication
- **OAuth scope enforcement** -- Mastodon-compatible hierarchical scope checking on all endpoints
- **Token hashing** -- access tokens stored as SHA-256 hashes, never plaintext
- **Domain block enforcement** -- blocked domains rejected at federation inbox level
- **HTML sanitization** -- allowlist-based sanitizer on both local and remote content
- **CSP headers** -- Content-Security-Policy, X-Content-Type-Options, X-Frame-Options on all responses
- **Rate limiting** -- KV-backed sliding window on auth, registration, and admin endpoints
- **Registration control** -- open, approval-required, or closed
- **Email domain blocks** -- prevent signups from blocked email domains

### Real-Time and Notifications
- **WebSocket streaming** -- live timeline updates via Cloudflare Durable Objects
- **Web Push notifications** -- VAPID (RFC 8292) + RFC 8291 encryption

### Content
- **URL preview cards** -- OpenGraph metadata fetching
- **Media uploads** -- R2 storage with async thumbnail processing
- **Polls** -- create and vote
- **Content warnings** and sensitive media flags
- **HTML sanitization** and content parsing (mentions, hashtags, links)

### Frontend
- **Internationalization** -- 12 language packs with lazy loading (en, ko, ja, zh-CN, zh-TW, es, fr, de, pt-BR, ru, ar, id)
- **Dark mode** -- system-aware and manual toggle
- **Responsive design** -- mobile-first with Tailwind CSS
- **Admin dashboard** -- accounts, reports, domain blocks, rules, settings, announcements, relays, custom emojis, federation

### Operations
- **Email** -- dedicated email-sender worker consuming from a queue, SMTP via worker-mailer (password reset, notifications)
- **Sentry integration** -- optional error tracking (admin opt-in)

---

## Architecture

SiliconBeest runs as 3 Cloudflare Workers:

```
                        Clients (Mastodon apps, web)
                                   |
                                   v
                     +---------------------------+
                     |    Cloudflare CDN / Edge   |
                     +---------------------------+
                                   |
                                   v
              +---------------------------------------+
              |          siliconbeest (main)           |
              |   Hono API server + Vue 3 SPA frontend |
              |                                       |
              |  - Mastodon API v1/v2                  |
              |  - OAuth 2.0 + PKCE + WebAuthn        |
              |  - Fedify (ActivityPub federation)     |
              |  - Admin API with rate limiting        |
              |  - WebSocket streaming (Durable Objs)  |
              |  - Vue 3 SPA (Tailwind, Pinia, i18n)  |
              +---------------------------------------+
                    |     |      |       |
                    v     v      v       v
              +-----+ +----+ +--------+ +------------------+
              |  D1 | | R2 | |   KV   | |  Durable Objects |
              | SQL | |blob | |cache/  | |  (StreamingDO)   |
              | DB  | |store| |session | |  WebSocket live  |
              +-----+ +----+ +--------+ +------------------+

         +----------------------------+   +-----------------------------+
         | siliconbeest-queue-consumer|   | siliconbeest-email-sender   |
         |                            |   |                             |
         |  - Federation delivery     |   |  - SMTP via worker-mailer   |
         |  - Timeline fanout         |   |  - Password reset emails    |
         |  - Notifications           |   |  - Notification emails      |
         |  - Media processing        |   +-----------------------------+
         |  - Web Push sending        |               |
         +----------------------------+          +--------+
                |            |                   | Queue  |
          +------+     +------+                 | email  |
          | Queue |     | Queue |                +--------+
          | fed.  |     | int.  |
          +------+     +------+
```

The main worker enqueues email jobs to the `email` queue via its `QUEUE_EMAIL` producer binding. The email-sender worker consumes from that queue and sends mail via SMTP using [worker-mailer](https://github.com/nicepkg/worker-mailer).

---

## Tech Stack

| Layer         | Technology                                 |
| ------------- | ------------------------------------------ |
| API Server    | Hono + Chanfana + Zod on Cloudflare Workers |
| Federation    | Fedify v2.1.0 + @fedify/cfworkers            |
| Frontend      | Vue 3 + Vite + Tailwind CSS + Headless UI   |
| Database      | Cloudflare D1 (SQLite)                      |
| Object Store  | Cloudflare R2                               |
| Cache/Session | Cloudflare KV                               |
| Job Queues    | Cloudflare Queues                           |
| Streaming     | Cloudflare Durable Objects (Hibernatable WS)|
| Auth          | bcryptjs, OAuth 2.0, TOTP (RFC 6238)        |
| Web Push      | VAPID (RFC 8292) + RFC 8291 encryption      |
| Email         | worker-mailer (SMTP)                        |
| IDs           | ULID (time-sortable)                        |
| i18n          | vue-i18n (frontend) + custom (API errors)   |
| Error Track   | Sentry (optional)                           |
| Testing       | Vitest + @cloudflare/vitest-pool-workers     |

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 4.x (`npm i -g wrangler`)
- A Cloudflare account with **Workers Paid plan** ($5/month)
- A domain managed by Cloudflare (for custom domain deployment)

### 1. Clone and Install

```bash
git clone https://github.com/SJang1/siliconbeest.git
cd siliconbeest

# Install dependencies for all sub-projects
cd siliconbeest && npm install && cd ..
cd siliconbeest-queue-consumer && npm install && cd ..
cd siliconbeest-email-sender && npm install && cd ..
```

### 2. Interactive Setup

The setup script creates all Cloudflare resources, generates cryptographic keys, and configures your instance:

```bash
./scripts/setup.sh
```

It will prompt for:

| Setting | Description | Example |
|---------|-------------|---------|
| **Project prefix** | Resource naming prefix | `myserver` (default: `siliconbeest`) |
| **Instance domain** | Your Fediverse domain | `social.example.com` |
| **Instance title** | Display name | `My Fediverse Server` |
| **Registration mode** | open / approval / closed | `open` |
| **Admin email** | Administrator email | `admin@example.com` |
| **Admin username** | Administrator handle | `admin` |
| **Admin password** | Administrator password | (hidden input) |
| **Sentry DSN** | Error tracking (optional) | `https://...@sentry.io/...` |

The script automatically:
- Creates D1 database, R2 bucket, KV namespaces (CACHE, SESSIONS, FEDIFY_KV), Queues
- Generates VAPID key pair (ECDSA P-256) for Web Push
- Generates OTP encryption key for 2FA secrets
- Updates all `wrangler.jsonc` files with resource IDs
- Sets secrets via `wrangler secret put`
- Applies D1 database migrations
- Creates the admin user account
- Writes `siliconbeest/.env` with VAPID public key and optional Sentry DSN

### 3. Deploy

```bash
# Deploy with custom domain routing (recommended)
./scripts/deploy.sh --domain social.example.com

# Or deploy to *.workers.dev subdomains (for testing)
./scripts/deploy.sh
```

### 4. DNS

If using a subdomain (e.g., `social.example.com`), add a DNS record in Cloudflare:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| AAAA | social | 100:: | Proxied |

(The `100::` is a dummy address -- Cloudflare Workers routes handle the traffic.)

### 5. Cloudflare Bot Protection (CRITICAL)

> **Without this step, federation is completely broken.**

Cloudflare's Bot Fight Mode blocks ActivityPub traffic (403 to `/users/*`, `/inbox`). You must create a WAF **Skip** rule -- see **[scripts/README.md](scripts/README.md#cloudflare-bot-protection-critical)** for full instructions.

---

## Updating an Existing Instance

```bash
# Full update: git pull -> install deps -> type check -> tests -> migrations -> deploy
./scripts/update.sh

# With specific branch
./scripts/update.sh --branch release/v0.2.0

# Preview changes without deploying
./scripts/update.sh --dry-run
```

See [scripts/README.md](scripts/README.md) for all update options and flags.

---

## Project Structure

```
siliconbeest/
  siliconbeest/                 # Main app — API server (Hono) + Vue 3 SPA frontend
    server/worker/              #   Hono API server (Mastodon API, OAuth, ActivityPub)
    server/worker/federation/   #   Fedify inbox/outbox, dispatchers, helpers
    server/worker/middleware/    #   Auth, rate limiting, CORS, scope enforcement
    server/worker/endpoints/    #   All API route handlers
    src/                        #   Vue 3 frontend (components, views, stores, i18n)
    migrations/                 #   D1 database migrations (22 files)
    test/worker/                #   API server tests (55 files)
    test/                       #   Vue frontend tests (11 files)
  siliconbeest-queue-consumer/  # Async job processor (federation + internal queues)
  siliconbeest-email-sender/    # Email sender (SMTP via worker-mailer)
  scripts/                      # Setup, deploy, and maintenance scripts
  docs/                         # Architecture docs, security audit, migration guides
  FEDERATION.md                 # Federation capabilities (FEP-67ff)
```

See each sub-project README for details:

- [siliconbeest/](siliconbeest/) -- Main Application: API Worker + Vue Frontend ([README](siliconbeest/README.md))
- [siliconbeest-queue-consumer/](siliconbeest-queue-consumer/) -- Queue Consumer ([README](siliconbeest-queue-consumer/README.md))
- [siliconbeest-email-sender/](siliconbeest-email-sender/) -- Email Sender ([README](siliconbeest-email-sender/README.md))
- [scripts/](scripts/) -- Setup, deploy, update, backup scripts ([README](scripts/README.md))

---

## Testing

```bash
cd siliconbeest

# API worker tests (55 test files, 805 tests)
npx vitest run --config vitest.worker.config.ts

# Vue frontend tests (11 test files)
npx vitest run

# Both suites
npx vitest run --config vitest.worker.config.ts && npx vitest run
```

| Suite | Test Files | Coverage Areas |
|-------|------------|----------------|
| Worker | 55 | Auth (suspension, scopes), OAuth (PKCE, approval flow, token hashing), accounts, statuses, timelines, notifications, search, lists, markers, media, bookmarks, favourites, blocks/mutes, conversations, filters, tags, polls, reports, admin (accounts, roles, domain blocks, rules, announcements, relays, custom emojis), ActivityPub, federation (Fedify dispatchers, inbox processing, delivery, domain block enforcement), collection pagination, activity idempotency, featured collections, emoji reactions, custom emojis, quote posts, WebFinger, NodeInfo, content parsing, serializers, sanitization, ULID, instance, discovery, passwords, WebAuthn, proxy (SSRF), email verification, email domain blocks, scope enforcement |
| Vue | 11 | Stores (auth, ui, statuses, timelines), components (Avatar, LoadingSpinner, StatusActions, FollowButton), API client, i18n, router guards |

---

## Scripts Quick Reference

All scripts read resource names from [`scripts/config.sh`](scripts/config.sh). Customize by setting `PROJECT_PREFIX` or creating `scripts/config.env` (see [`scripts/config.env.example`](scripts/config.env.example)).

| Script | What it does |
|--------|-------------|
| `./scripts/setup.sh` | Interactive first-time setup (creates resources, keys, admin) |
| `./scripts/deploy.sh --domain social.example.com` | Deploy with custom domain routing |
| `./scripts/update.sh` | Pull, test, migrate, redeploy (production updates) |
| `./scripts/backup.sh` | Backup D1 + R2 data |
| `./scripts/migrate.sh` | Apply D1 database migrations |
| `./scripts/seed-admin.sh` | Create an admin user account |
| `./scripts/delete-account.sh` | AP-compliant account deletion (sends Delete to all peers) |
| `./scripts/generate-vapid-keys.sh` | Generate/rotate VAPID key pair |
| `./scripts/configure-domain.sh` | Set up Workers Routes for a custom domain |
| `./scripts/sync-config.sh` | Sync Cloudflare resource IDs → wrangler.jsonc (new machine/recovery) |

See the full [scripts documentation](scripts/README.md) for all options and flags.

---

## Secrets and Environment Variables

### Secrets (stored in Cloudflare, never in code)

| Secret | Workers | Set by |
|--------|---------|--------|
| `VAPID_PRIVATE_KEY` | worker, queue-consumer | `setup.sh` |
| `VAPID_PUBLIC_KEY` | worker, queue-consumer | `setup.sh` |
| `OTP_ENCRYPTION_KEY` | worker | `setup.sh` |

### Environment Variables (in wrangler.jsonc)

| Variable | Description | Default |
|----------|-------------|---------|
| `INSTANCE_DOMAIN` | Your instance domain | `siliconbeest.com` |
| `INSTANCE_TITLE` | Instance display name | `SiliconBeest` |
| `REGISTRATION_MODE` | `open` / `approval` / `closed` | `open` |

### Frontend Environment (siliconbeest/.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_INSTANCE_DOMAIN` | Instance domain (for meta tags) | Yes |
| `VITE_VAPID_PUBLIC_KEY` | VAPID public key (for Web Push) | Yes |
| `VITE_SENTRY_DSN` | Sentry DSN for error tracking | No |

---

## Local Development

```bash
# Terminal 1 -- Main app: API worker + Vue frontend (port 8787)
cd siliconbeest && npx wrangler dev

# Terminal 2 -- Queue consumer
cd siliconbeest-queue-consumer && npx wrangler dev

# Terminal 3 -- Email sender
cd siliconbeest-email-sender && npx wrangler dev

# Terminal 4 -- Vue frontend dev server with HMR (port 5173, optional)
cd siliconbeest && npm run dev
```

For local D1, apply migrations first:

```bash
cd siliconbeest && npx wrangler d1 migrations apply siliconbeest-db --local
```

---

## Cost Estimate

Running on Cloudflare Workers Paid plan ($5/month base):

| Resource | 100 users/mo | 1000 users/mo |
|----------|-------------|---------------|
| Workers requests | ~1.5M (incl.) | ~15M ($1.50) |
| D1 reads | ~300K (incl.) | ~3M (incl.) |
| D1 writes | ~30K (incl.) | ~300K (incl.) |
| R2 storage | ~1 GB ($0.02) | ~10 GB ($0.15) |
| KV operations | ~500K (incl.) | ~5M (incl.) |
| DO requests | ~300K (incl.) | ~3M ($0.30) |
| Queues | ~100K (incl.) | ~1M (incl.) |
| **Total** | **~$5/mo** | **~$7/mo** |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-change`
3. Make your changes and add tests
4. Run tests: `cd siliconbeest && npx vitest run --config vitest.worker.config.ts && npx vitest run`
5. Submit a pull request

All new API endpoints should include Zod validation schemas and integration tests.

---

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0)

This is the standard license for Fediverse server software. Any modified version deployed as a network service must make its source code available.
