# SiliconBeest

**Serverless Fediverse platform on Cloudflare Workers.**

SiliconBeest is a fully-featured [Mastodon API](https://docs.joinmastodon.org/api/)-compatible social networking server built entirely on the Cloudflare developer platform. It federates with the wider Fediverse via [ActivityPub](https://www.w3.org/TR/activitypub/) and can be deployed to a global edge network with zero traditional server infrastructure.

> Version **0.1.0** — Early development

---

## Features

- **Mastodon API compatible** — works with existing clients (Tusky, Elk, Ice Cubes, Ivory, etc.)
- **ActivityPub federation** — interoperate with Mastodon, Misskey, Pleroma, and any ActivityPub server
- **OAuth 2.0 + PKCE + TOTP 2FA** — standards-compliant authentication
- **Google OAuth SSO** — optional single sign-on (extensible to other providers)
- **Cloudflare Zero Trust** — optional enterprise SSO integration
- **Internationalization** — 12 language packs with lazy loading (en, ko, ja, zh-CN, zh-TW, es, fr, de, pt-BR, ru, ar, id)
- **Admin panel** — account management, domain blocks, IP blocks, reports, rules, instance settings
- **Web Push notifications** — VAPID + RFC 8291 encrypted push
- **WebSocket streaming** — live updates via Cloudflare Durable Objects
- **Media uploads** — R2 storage with async thumbnail processing
- **Optional Sentry** — error tracking (admin opt-in via environment variable)
- **Registration control** — open, approval-required, or closed (like Mastodon)

---

## Architecture

```
                        Clients (Mastodon apps, web)
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
     |  - Mastodon API v1/v2  |        |  - Tailwind CSS        |
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

---

## Tech Stack

| Layer         | Technology                                 |
| ------------- | ------------------------------------------ |
| API Server    | Hono + Chanfana + Zod on Cloudflare Workers |
| Frontend      | Vue 3 + Vite + Tailwind CSS + Headless UI   |
| Database      | Cloudflare D1 (SQLite)                      |
| Object Store  | Cloudflare R2                               |
| Cache/Session | Cloudflare KV                               |
| Job Queues    | Cloudflare Queues                           |
| Streaming     | Cloudflare Durable Objects (Hibernatable WS)|
| Auth          | bcryptjs, OAuth 2.0, TOTP (RFC 6238)        |
| Web Push      | VAPID (RFC 8292) + RFC 8291 encryption      |
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
git clone https://github.com/your-org/siliconbeest.git
cd siliconbeest

# Install dependencies for all sub-projects
cd siliconbeest-worker && npm install && cd ..
cd siliconbeest-queue-consumer && npm install && cd ..
cd siliconbeest-vue && npm install && cd ..
```

### 2. Interactive Setup

The setup script creates all Cloudflare resources, generates cryptographic keys, and configures your instance:

```bash
./scripts/setup.sh
```

It will prompt for:

| Setting | Description | Example |
|---------|-------------|---------|
| **Instance domain** | Your Fediverse domain | `social.example.com` |
| **Instance title** | Display name | `My Fediverse Server` |
| **Registration mode** | open / approval / closed | `open` |
| **Admin email** | Administrator email | `admin@example.com` |
| **Admin username** | Administrator handle | `admin` |
| **Admin password** | Administrator password | (hidden input) |
| **Sentry DSN** | Error tracking (optional) | `https://...@sentry.io/...` |

The script automatically:
- Creates D1 database, R2 bucket, KV namespaces, Queues
- Generates VAPID key pair (ECDSA P-256) for Web Push
- Generates OTP encryption key for 2FA secrets
- Updates all `wrangler.jsonc` files with resource IDs
- Sets secrets via `wrangler secret put`
- Applies D1 database migrations
- Creates the admin user account
- Writes `siliconbeest-vue/.env` with VAPID public key and optional Sentry DSN

### 3. Deploy

```bash
# Deploy with custom domain routing (recommended)
./scripts/deploy.sh --domain social.example.com

# Or deploy to *.workers.dev subdomains (for testing)
./scripts/deploy.sh
```

The `--domain` flag automatically:
- Updates `INSTANCE_DOMAIN` in worker configuration
- Configures Cloudflare Workers Routes:
  - `social.example.com/api/*` → API Worker
  - `social.example.com/oauth/*` → API Worker
  - `social.example.com/.well-known/*` → API Worker
  - `social.example.com/users/*` → API Worker
  - `social.example.com/inbox` → API Worker
  - `social.example.com/nodeinfo/*` → API Worker
  - `social.example.com/*` → Vue Frontend (catch-all)
- Deploys all 3 workers

### 4. DNS

If using a subdomain (e.g., `social.example.com`), add a DNS record in Cloudflare:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| AAAA | social | 100:: | Proxied |

(The `100::` is a dummy address — Cloudflare Workers routes handle the traffic.)

---

## Deployment Options

### Deploy Flags

```bash
./scripts/deploy.sh [OPTIONS]

Options:
  --domain <domain>   Configure custom domain routes
  --dry-run           Show what would be deployed without deploying
  --skip-migrations   Skip D1 migration step
  -h, --help          Show help
```

### Individual Worker Deployment

```bash
# Deploy only the API worker
cd siliconbeest-worker && npx wrangler deploy

# Deploy only the queue consumer
cd siliconbeest-queue-consumer && npx wrangler deploy

# Deploy only the frontend
cd siliconbeest-vue && npx wrangler deploy
```

### Updating an Existing Instance

When a new version is released:

```bash
# Full update: git pull → install deps → type check → tests → migrations → deploy
./scripts/update.sh

# With specific branch
./scripts/update.sh --branch release/v0.2.0

# Preview changes without deploying
./scripts/update.sh --dry-run

# Skip tests for hotfixes (not recommended for regular updates)
./scripts/update.sh --skip-tests
```

The `update.sh` script performs these steps in order:

1. **Git pull** — fetches and merges latest code (shows changelog)
2. **Install dependencies** — runs `npm install` for all 3 projects
3. **Type check** — `tsc --noEmit` for worker, `vue-tsc --noEmit` for frontend
4. **Run tests** — 228 tests across worker (118) and frontend (110)
5. **Database migrations** — applies any new migration files to remote D1
6. **Build frontend** — `vite build` for Vue SPA
7. **Deploy** — `wrangler deploy` for all 3 workers

If any step fails (type errors, test failures, migration errors), the script stops immediately and does not deploy.

```bash
# Update flags
./scripts/update.sh --help

Options:
  --branch <name>   Git branch to pull (default: main)
  --skip-pull       Skip git pull (deploy current working tree)
  --skip-tests      Skip test step
  --dry-run         Run checks without deploying
```

### Manual Update (Step by Step)

If you prefer manual control:

```bash
# 1. Pull latest code
git pull origin main

# 2. Install dependencies
cd siliconbeest-worker && npm install && cd ..
cd siliconbeest-queue-consumer && npm install && cd ..
cd siliconbeest-vue && npm install && cd ..

# 3. Run tests
cd siliconbeest-worker && npm test && cd ..
cd siliconbeest-vue && npm test && cd ..

# 4. Apply migrations (reads DB name from wrangler.jsonc)
cd siliconbeest-worker && npx wrangler d1 migrations apply siliconbeest-db --remote && cd ..

# 5. Deploy
./scripts/deploy.sh --skip-migrations  # migrations already applied above
```

### Domain Configuration (Standalone)

If you need to change the domain after initial deployment:

```bash
./scripts/configure-domain.sh social.example.com
```

---

## Secrets and Environment Variables

### Secrets (stored in Cloudflare, never in code)

| Secret | Workers | Set by |
|--------|---------|--------|
| `VAPID_PRIVATE_KEY` | worker, queue-consumer | `setup.sh` |
| `VAPID_PUBLIC_KEY` | worker, queue-consumer | `setup.sh` |
| `OTP_ENCRYPTION_KEY` | worker | `setup.sh` |

Secrets are set via `wrangler secret put`. To rotate:

```bash
# Regenerate VAPID keys
./scripts/generate-vapid-keys.sh --set-secrets

# Regenerate OTP encryption key (WARNING: invalidates existing 2FA)
openssl rand -hex 32 | wrangler secret put OTP_ENCRYPTION_KEY --name siliconbeest-worker
```

### Environment Variables (in wrangler.jsonc)

| Variable | Description | Default |
|----------|-------------|---------|
| `INSTANCE_DOMAIN` | Your instance domain | `siliconbeest.com` |
| `INSTANCE_TITLE` | Instance display name | `SiliconBeest` |
| `REGISTRATION_MODE` | `open` / `approval` / `closed` | `open` |

### Frontend Environment (siliconbeest-vue/.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_INSTANCE_DOMAIN` | Instance domain (for meta tags) | Yes |
| `VITE_VAPID_PUBLIC_KEY` | VAPID public key (for Web Push) | Yes |
| `VITE_SENTRY_DSN` | Sentry DSN for error tracking | No (optional) |

The `.env` file is auto-generated by `setup.sh`. To enable Sentry later:

```bash
# Edit the .env file
echo "VITE_SENTRY_DSN=https://your-key@sentry.io/your-project" >> siliconbeest-vue/.env

# Redeploy the frontend
cd siliconbeest-vue && npx wrangler deploy
```

---

## Local Development

```bash
# Terminal 1 — API worker (port 8787)
cd siliconbeest-worker && npx wrangler dev

# Terminal 2 — Queue consumer
cd siliconbeest-queue-consumer && npx wrangler dev

# Terminal 3 — Vue frontend (port 5173)
cd siliconbeest-vue && npm run dev
```

For local D1, apply migrations first:

```bash
cd siliconbeest-worker && npx wrangler d1 migrations apply siliconbeest-db --local
```

---

## Testing

```bash
# API worker tests (118 tests)
cd siliconbeest-worker && npm test

# Vue frontend tests (110 tests)
cd siliconbeest-vue && npm test

# Run all tests
cd siliconbeest-worker && npm test && cd ../siliconbeest-vue && npm test
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| Worker (API + Federation) | 118 | Auth, accounts, statuses, timelines, notifications, discovery, ActivityPub, admin, search, lists, markers, media |
| Vue (Frontend) | 110 | Stores (auth, ui, statuses, timelines), components (Avatar, Spinner, StatusActions, FollowButton), API client, i18n, router guards |
| **Total** | **228** | |

---

## Maintenance

### Backup

```bash
./scripts/backup.sh                  # Backup D1 + R2
./scripts/backup.sh --skip-r2       # D1 only
./scripts/backup.sh --output-dir /path/to/backup
```

### Database Migrations

```bash
./scripts/migrate.sh --local         # Apply to local D1
./scripts/migrate.sh --remote        # Apply to production
./scripts/migrate.sh --dry-run       # Preview pending migrations
```

To create a new migration:

```bash
# Create a new migration file
touch siliconbeest-worker/migrations/0002_add_reactions.sql

# Write your SQL (example)
cat > siliconbeest-worker/migrations/0002_add_reactions.sql << 'SQL'
CREATE TABLE reactions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  status_id   TEXT NOT NULL REFERENCES statuses(id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(account_id, status_id, name)
);
CREATE INDEX idx_reactions_status ON reactions(status_id);
SQL

# Test locally first
./scripts/migrate.sh --local

# Apply to production
./scripts/migrate.sh --remote
```

Migrations are numbered sequentially (`0001_`, `0002_`, ...) and applied in order. D1 tracks which migrations have been applied — only new ones run.

### Cloudflare Resource Names

Resource names (D1 database, R2 bucket, KV namespaces, queues) are configured in each project's `wrangler.jsonc`. The deploy and migration scripts read these dynamically — they are **not hardcoded** in the scripts.

If you need different resource names per environment (staging vs production):

```bash
# The resource names are in wrangler.jsonc:
#   d1_databases[0].database_name  →  "siliconbeest-db"
#   r2_buckets[0].bucket_name      →  "siliconbeest-media"
#   kv_namespaces[0..1].id         →  KV namespace IDs
#   queues.producers[0..1].queue   →  "siliconbeest-federation", "siliconbeest-internal"

# To use different names, either:
# 1. Edit wrangler.jsonc directly
# 2. Use wrangler environments: wrangler deploy --env staging
# 3. Run setup.sh again with different names (creates new resources)
```

### Admin User

```bash
./scripts/seed-admin.sh admin@example.com admin MyPassword123
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

## Project Structure

```
siliconbeest/
  siliconbeest-worker/          # API server (Hono on Workers)
  siliconbeest-queue-consumer/  # Async job processor (Queues consumer)
  siliconbeest-vue/             # Web frontend (Vue 3 SPA)
  scripts/                      # Setup, deploy, and maintenance scripts
```

See each sub-project README for details:

- [siliconbeest-worker/README.md](siliconbeest-worker/README.md) — API Worker (endpoints, federation, testing)
- [siliconbeest-queue-consumer/README.md](siliconbeest-queue-consumer/README.md) — Queue Consumer (handlers, retry logic)
- [siliconbeest-vue/README.md](siliconbeest-vue/README.md) — Vue Frontend (components, stores, i18n)
- [scripts/README.md](scripts/README.md) — Scripts (setup flow, maintenance)

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-change`
3. Make your changes and add tests
4. Run tests: `cd siliconbeest-worker && npm test && cd ../siliconbeest-vue && npm test`
5. Submit a pull request

All new API endpoints should include Zod validation schemas and integration tests.

---

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0)

This is the standard license for Fediverse server software. Any modified version deployed as a network service must make its source code available.
