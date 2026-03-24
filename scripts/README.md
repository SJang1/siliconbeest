# SiliconBeest Scripts

Setup, deployment, and maintenance scripts for managing a SiliconBeest instance.

All scripts share a central configuration via **`config.sh`** -- no resource names are hardcoded.

---

## Configuration

### config.sh (central defaults)

Every script sources `config.sh` which defines all resource names based on a single **`PROJECT_PREFIX`** (default: `siliconbeest`).

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_PREFIX` | `siliconbeest` | Master prefix -- changes all defaults |
| `WORKER_NAME` | `{prefix}-worker` | API Worker name |
| `CONSUMER_NAME` | `{prefix}-queue-consumer` | Queue Consumer name |
| `VUE_NAME` | `{prefix}-vue` | Frontend Worker name |
| `D1_DATABASE_NAME` | `{prefix}-db` | D1 database name |
| `R2_BUCKET_NAME` | `{prefix}-media` | R2 bucket name |
| `KV_CACHE_TITLE` | `{prefix}-CACHE` | KV namespace for cache |
| `KV_SESSIONS_TITLE` | `{prefix}-SESSIONS` | KV namespace for sessions |
| `QUEUE_FEDERATION` | `{prefix}-federation` | Federation queue |
| `QUEUE_INTERNAL` | `{prefix}-internal` | Internal queue |
| `QUEUE_DLQ` | `{prefix}-federation-dlq` | Dead letter queue |

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
| [`configure-domain.sh`](#configure-domainsh) | Set up Workers Routes for a custom domain |
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
1. Creates D1 database, R2 bucket, KV namespaces, Queues
2. Generates VAPID key pair (ECDSA P-256) and OTP encryption key
3. Updates all `wrangler.jsonc` files with resource IDs
4. Sets secrets via `wrangler secret put`
5. Applies D1 migrations
6. Creates admin user
7. Writes `siliconbeest-vue/.env`

---

## deploy.sh

Build and deploy all 3 workers. Optionally configures custom domain routes.

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
| `--domain <domain>` | Configure Workers Routes for custom domain |
| `--dry-run` | Show what would be deployed |
| `--skip-migrations` | Skip D1 migration step |

When `--domain` is used, it automatically:
- Updates `INSTANCE_DOMAIN` in worker config
- Injects API routes (`/api/*`, `/oauth/*`, `/.well-known/*`, `/users/*`, `/inbox`, `/nodeinfo/*`) to the API Worker
- Injects catch-all route (`/*`) to the Vue Frontend
- Deploys all workers

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
2. `npm install` for all projects
3. TypeScript type check (worker + vue)
4. Run tests
5. Apply D1 migrations
6. Build frontend
7. Deploy all workers

If any step fails (type errors, test failures, migration errors), the script stops immediately and does not deploy.

---

## configure-domain.sh

Configure Cloudflare Workers Routes for a custom domain (standalone, without redeploying).

```bash
./scripts/configure-domain.sh social.example.com
```

Creates these routes:

| Route | Worker |
|-------|--------|
| `domain/api/*` | API Worker |
| `domain/oauth/*` | API Worker |
| `domain/.well-known/*` | API Worker |
| `domain/users/*` | API Worker |
| `domain/inbox` | API Worker |
| `domain/nodeinfo/*` | API Worker |
| `domain/*` | Vue Frontend (catch-all) |

---

## generate-vapid-keys.sh

Generate ECDSA P-256 key pair for Web Push (VAPID).

```bash
# Print keys to stdout
./scripts/generate-vapid-keys.sh

# Generate and set as Cloudflare secrets
./scripts/generate-vapid-keys.sh --set-secrets
```

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

Apply pending D1 database migrations.

```bash
./scripts/migrate.sh --local       # Local development
./scripts/migrate.sh --remote      # Production (default)
./scripts/migrate.sh --dry-run     # List pending without applying
```

To create a new migration:
```bash
touch siliconbeest-worker/migrations/0003_my_change.sql
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

Follows the [ActivityPub Delete activity spec](https://www.w3.org/TR/activitypub/#delete-activity-outbound) -- remote servers should remove all cached data for the deleted actor.

---

## Cloudflare Bot Protection (CRITICAL)

Cloudflare's **Bot Fight Mode** and **Super Bot Fight Mode** block ActivityPub federation traffic -- other Fediverse servers appear as "bots" and receive 403 responses on `/users/*` and `/inbox`.

**You MUST create a WAF exception rule:**

1. Go to **Security > WAF > Custom Rules** in the Cloudflare Dashboard
2. Create a **Skip** rule with this expression:
   ```
   (http.request.uri.path matches "^/users/.*" or
    http.request.uri.path eq "/inbox" or
    http.request.uri.path eq "/actor" or
    http.request.uri.path matches "^/nodeinfo/.*" or
    http.request.uri.path matches "^/.well-known/.*")
   ```
3. Action: **Skip** -- check **All remaining custom rules** + **Super Bot Fight Mode**
4. Place it **FIRST** in your rule list (highest priority)

**Verify:**
```bash
curl -H 'Accept: application/activity+json' https://your-domain.com/users/admin
# Should return JSON, NOT an HTML challenge page
```

Without this rule, federation is completely broken -- no remote server can discover or interact with your instance.

---

## Maintenance

### Rotate VAPID keys

```bash
./scripts/generate-vapid-keys.sh --set-secrets
# NOTE: This invalidates all existing Web Push subscriptions
```

### Check dead letter queue

Failed federation deliveries go to the DLQ. Inspect via the Cloudflare dashboard (Queues tab).

### Rotate OTP encryption key

```bash
# WARNING: Invalidates all existing 2FA enrollments
openssl rand -hex 32 | wrangler secret put OTP_ENCRYPTION_KEY --name $WORKER_NAME
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
# Dry run — shows what would change, no files modified
./scripts/sync-config.sh

# Apply — regenerates all 3 wrangler.jsonc files
./scripts/sync-config.sh --apply
```

**What it does:**
1. Verifies `wrangler` CLI authentication
2. Looks up D1 database ID by name
3. Looks up KV namespace IDs by title
4. Verifies R2 bucket existence
5. Reads existing domain/title/registration from current config
6. Regenerates `siliconbeest-worker/wrangler.jsonc`, `siliconbeest-queue-consumer/wrangler.jsonc`, and `siliconbeest-vue/wrangler.jsonc`

**Prerequisites:** `wrangler` CLI authenticated (`npx wrangler login`)
