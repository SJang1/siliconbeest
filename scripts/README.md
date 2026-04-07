# SiliconBeest Scripts

Setup, deployment, and maintenance scripts for managing a SiliconBeest instance.

All scripts share a central configuration via **`config.sh`** -- no resource names are hardcoded.

## Architecture

SiliconBeest uses a **unified worker** architecture:

- **`siliconbeest`** -- single Cloudflare Worker that serves both the Vue frontend and the API/ActivityPub backend. Deployed from `siliconbeest/`.
- **`siliconbeest-queue-consumer`** -- separate worker that processes federation and internal queues.
- **`siliconbeest-email-sender`** -- separate worker that processes the email queue.

---

## Configuration

### config.sh (central defaults)

Every script sources `config.sh` which defines all resource names based on a single **`PROJECT_PREFIX`** (default: `siliconbeest`).

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_PREFIX` | `siliconbeest` | Master prefix -- changes all defaults |
| `MAIN_WORKER_NAME` | `{prefix}` | Unified worker name (Vue + API) |
| `CONSUMER_NAME` | `{prefix}-queue-consumer` | Queue Consumer name |
| `EMAIL_SENDER_NAME` | `{prefix}-email-sender` | Email Sender Worker name |
| `D1_DATABASE_NAME` | `{prefix}-db` | D1 database name |
| `R2_BUCKET_NAME` | `{prefix}-media` | R2 bucket name |
| `KV_CACHE_TITLE` | `{prefix}-CACHE` | KV namespace for cache |
| `KV_SESSIONS_TITLE` | `{prefix}-SESSIONS` | KV namespace for sessions |
| `KV_FEDIFY_TITLE` | `{prefix}-FEDIFY_KV` | KV namespace for Fedify federation state |
| `QUEUE_FEDERATION` | `{prefix}-federation` | Federation queue |
| `QUEUE_INTERNAL` | `{prefix}-internal` | Internal queue |
| `QUEUE_EMAIL` | `{prefix}-email` | Email queue (consumed by email-sender) |
| `QUEUE_DLQ` | `{prefix}-federation-dlq` | Dead letter queue |

### Directory layout

| Variable | Path | Description |
|----------|------|-------------|
| `MAIN_DIR` | `siliconbeest/` | Unified worker + Vue frontend |
| `CONSUMER_DIR` | `siliconbeest-queue-consumer/` | Queue consumer worker |
| `EMAIL_DIR` | `siliconbeest-email-sender/` | Email sender worker |

### Customizing names

**Option 1:** Environment variable (one-off)
```bash
PROJECT_PREFIX=myserver ./scripts/setup.sh
```

**Option 2:** Persistent config file
```bash
cp scripts/config.env.example scripts/config.env
# Edit config.env with your preferred names
```

**Option 3:** Override individual names
```bash
export D1_DATABASE_NAME=my-custom-db
export R2_BUCKET_NAME=my-media-bucket
./scripts/deploy.sh --domain social.example.com
```

---

## Script Reference

| Script | Description |
|--------|-------------|
| [`config.sh`](#configsh-central-defaults) | Shared configuration (sourced by all scripts) |
| [`setup.sh`](#setupsh) | Interactive first-time setup |
| [`deploy.sh`](#deploysh) | Deploy all workers |
| [`update.sh`](#updatesh) | Pull, test, migrate, and redeploy |
| [`configure-domain.sh`](#configure-domainsh) | Set up custom domain for the unified worker |
| [`generate-vapid-keys.sh`](#generate-vapid-keyssh) | Generate VAPID key pair for Web Push |
| [`seed-admin.sh`](#seed-adminsh) | Create an admin user account |
| [`migrate.sh`](#migratesh) | Apply D1 database migrations |
| [`backup.sh`](#backupsh) | Backup D1 database and R2 objects |
| [`delete-account.sh`](#delete-accountsh) | AP-compliant account deletion |
| [`sync-config.sh`](#sync-configsh) | Sync Cloudflare resource IDs to wrangler.jsonc |

---

## setup.sh

Interactive first-time setup. Creates all Cloudflare resources, generates cryptographic keys, configures secrets, applies migrations, and seeds an admin user.

```bash
./scripts/setup.sh
```

Prompts for:
- **Project prefix** (default: `siliconbeest`) -- determines all resource names
- **Instance domain** (e.g. `social.example.com`)
- **Instance title**
- **Registration mode** (open / approval / closed)
- **Admin email, username, password**
- **Sentry DSN** (optional)

What it does:
1. Creates D1 database, R2 bucket, KV namespaces (CACHE, SESSIONS, FEDIFY_KV), Queues
2. Generates VAPID key pair (ECDSA P-256) and OTP encryption key
3. Updates `siliconbeest/wrangler.jsonc` with resource IDs
4. Sets OTP_ENCRYPTION_KEY secret via `wrangler secret put`
5. Stores VAPID keys in D1 settings table
6. Applies D1 migrations
7. Creates admin user
8. Writes `siliconbeest/.env`

---

## deploy.sh

Build and deploy all 3 workers. Optionally configures custom domain.

```bash
# Deploy with custom domain
./scripts/deploy.sh --domain social.example.com

# Deploy to workers.dev subdomains
./scripts/deploy.sh

# Preview without deploying
./scripts/deploy.sh --dry-run

# Skip migrations
./scripts/deploy.sh --skip-migrations
```

| Flag | Description |
|------|-------------|
| `--domain <domain>` | Configure custom domain for unified worker |
| `--dry-run` | Show what would be deployed |
| `--skip-migrations` | Skip D1 migration step |

The unified worker handles all routes (API + frontend) via a single custom_domain binding.

---

## update.sh

Production update workflow: pull latest code, validate, migrate, and deploy.

```bash
# Standard update
./scripts/update.sh

# Update from a specific branch
./scripts/update.sh --branch release/v0.2.0

# Dry run (check everything, don't deploy)
./scripts/update.sh --dry-run

# Skip tests for hotfixes
./scripts/update.sh --skip-tests
```

| Flag | Description |
|------|-------------|
| `--branch <name>` | Git branch to pull (default: `main`) |
| `--skip-pull` | Skip `git pull`, use current working tree |
| `--skip-tests` | Skip test step |
| `--dry-run` | Run all checks without deploying |

Steps performed:
1. `git pull` (shows changelog)
2. `pnpm install` for all projects
3. TypeScript type check (vue-tsc for unified worker, tsc for others)
4. Run tests
5. Apply D1 migrations
6. Build Vue frontend and deploy unified worker
7. Deploy queue consumer and email sender

If any step fails (type errors, test failures, migration errors), the script stops immediately and does not deploy.

---

## configure-domain.sh

Configure custom domain for the unified worker.

```bash
./scripts/configure-domain.sh social.example.com
```

Updates `INSTANCE_DOMAIN` and the custom_domain route pattern in `siliconbeest/wrangler.jsonc`, then rebuilds and redeploys.

---

## generate-vapid-keys.sh

Generate ECDSA P-256 key pair for Web Push (VAPID).

```bash
# Print keys to stdout
./scripts/generate-vapid-keys.sh

# Generate and store in D1 database
./scripts/generate-vapid-keys.sh --store-in-db
```

VAPID keys are stored in the D1 `settings` table, not as environment secrets.

---

## seed-admin.sh

Create an admin user account in the D1 database.

```bash
# With arguments
./scripts/seed-admin.sh admin@example.com admin MyPassword123

# Interactive (prompts for input)
./scripts/seed-admin.sh
```

---

## migrate.sh

Apply pending D1 database migrations. Migrations are located at `siliconbeest/migrations/`.

```bash
./scripts/migrate.sh --local       # Local development
./scripts/migrate.sh --remote      # Production (default)
./scripts/migrate.sh --dry-run     # List pending without applying
```

To create a new migration:
```bash
touch siliconbeest/migrations/0003_my_change.sql
# Write SQL, then:
./scripts/migrate.sh --local   # Test locally
./scripts/migrate.sh --remote  # Apply to production
```

---

## backup.sh

Backup D1 database tables and R2 object listing.

```bash
./scripts/backup.sh                    # Full backup (D1 + R2)
./scripts/backup.sh --skip-r2         # D1 only
./scripts/backup.sh --output-dir /backups
```

Backups are saved to `./backups/{timestamp}/`.

---

## delete-account.sh

ActivityPub-compliant account deletion. Sends a `Delete(Actor)` activity to ALL known federated servers, then removes the account from the local database.

**This is destructive and irreversible.**

```bash
# Dry run (shows what would happen)
./scripts/delete-account.sh <username>

# Actually execute
./scripts/delete-account.sh <username> --confirm

# Delete ALL accounts (server shutdown)
./scripts/delete-account.sh --all --confirm
```

---

## Cloudflare Bot Protection (CRITICAL)

Cloudflare's **Bot Fight Mode** and **Super Bot Fight Mode** block ActivityPub federation traffic -- other Fediverse servers appear as "bots" and receive 403 responses on `/users/*` and `/inbox`.

**You MUST create a WAF exception rule:**

1. Go to **Security > WAF > Custom Rules** in the Cloudflare Dashboard
2. Create a **Skip** rule with this expression:
   ```
   (any(http.request.headers["accept"][*] contains "application/activity+json") or
    any(http.request.headers["accept"][*] contains "application/ld+json") or
    any(http.request.headers["content-type"][*] contains "application/activity+json") or
    any(http.request.headers["content-type"][*] contains "application/ld+json")) and
   (http.request.uri.path matches "^/users/.*" or
    http.request.uri.path eq "/inbox" or
    http.request.uri.path eq "/actor" or
    http.request.uri.path matches "^/nodeinfo/.*" or
    http.request.uri.path matches "^/.well-known/.*")
   ```
   This only bypasses requests with ActivityPub content types (`application/activity+json`, `application/ld+json`) on federation endpoints -- normal browser traffic is still protected by bot rules.
3. Action: **Skip** -- check **All remaining custom rules** + **Super Bot Fight Mode**
4. Place it **FIRST** in your rule list (highest priority)

**Verify:**
```bash
curl -H 'Accept: application/activity+json' https://your-domain.com/users/admin
# Should return JSON, NOT an HTML challenge page
```

Without this rule, federation is completely broken -- no remote server can discover or interact with your instance.

---

## Secrets

The unified architecture only requires **one** wrangler secret:

```bash
# OTP encryption key (for 2FA)
wrangler secret put OTP_ENCRYPTION_KEY --name siliconbeest
```

VAPID keys are stored in the D1 `settings` table (not env secrets).

---

## Maintenance

### Rotate VAPID keys

```bash
./scripts/generate-vapid-keys.sh --store-in-db
# NOTE: This invalidates all existing Web Push subscriptions
```

### Check dead letter queue

Failed federation deliveries go to the DLQ. Inspect via the Cloudflare dashboard (Queues tab).

### Rotate OTP encryption key

```bash
# WARNING: Invalidates all existing 2FA enrollments
openssl rand -hex 32 | wrangler secret put OTP_ENCRYPTION_KEY --name siliconbeest
```

---

## sync-config.sh

Fetches resource IDs (D1, KV, R2, Queues) from your Cloudflare account and regenerates all `wrangler.jsonc` files with correct values.

**Use when:**
- You cloned the repo on a new machine
- Your `wrangler.jsonc` files are out of date or corrupted
- You switched Cloudflare accounts
- Resource IDs changed after recreation

```bash
# Dry run -- shows what would change, no files modified
./scripts/sync-config.sh

# Apply -- regenerates all wrangler.jsonc files
./scripts/sync-config.sh --apply
```

**What it does:**
1. Verifies `wrangler` CLI authentication
2. Looks up D1 database ID by name
3. Looks up KV namespace IDs by title
4. Verifies R2 bucket existence
5. Reads existing domain/title/registration from current config
6. Regenerates `siliconbeest/wrangler.jsonc`, `siliconbeest-queue-consumer/wrangler.jsonc`, and `siliconbeest-email-sender/wrangler.jsonc`

**Prerequisites:** `wrangler` CLI authenticated (`pnpm exec wrangler login`)
