# SiliconBeest Scripts

Setup and maintenance scripts for managing a SiliconBeest instance.

> Version **0.1.0**

## Script Reference

| Script | Description |
|--------|-------------|
| `setup.sh` | Interactive first-time setup (resources, keys, admin, Sentry) |
| `deploy.sh` | Deploy all workers (with optional `--domain` for custom domain) |
| `update.sh` | Pull code, test, migrate, and redeploy (production updates) |
| `configure-domain.sh` | Configure Workers Routes for a custom domain |
| `generate-vapid-keys.sh` | Generate VAPID key pair for Web Push |
| `seed-admin.sh` | Create an admin user account |
| `migrate.sh` | Apply D1 database migrations |
| `backup.sh` | Backup D1 database and R2 objects |

---

## Setup Flow

Follow these steps to configure a new SiliconBeest instance from scratch:

### 1. Create Cloudflare Resources

```bash
# Database
wrangler d1 create siliconbeest-db

# Object storage
wrangler r2 bucket create siliconbeest-media

# KV namespaces
wrangler kv namespace create CACHE
wrangler kv namespace create SESSIONS

# Queues
wrangler queues create siliconbeest-federation
wrangler queues create siliconbeest-internal
wrangler queues create siliconbeest-federation-dlq
```

After creating each resource, update the IDs in `siliconbeest-worker/wrangler.jsonc` and `siliconbeest-queue-consumer/wrangler.jsonc`.

### 2. Apply Database Migrations

```bash
cd siliconbeest-worker
wrangler d1 migrations apply siliconbeest-db --remote
```

### 3. Configure Environment Variables

Edit the `vars` section of `siliconbeest-worker/wrangler.jsonc`:

```jsonc
"vars": {
  "INSTANCE_DOMAIN": "your-domain.com",
  "INSTANCE_TITLE": "Your Instance Name",
  "REGISTRATION_MODE": "open"   // or "approval" or "closed"
}
```

### 4. Set Secrets

```bash
cd siliconbeest-worker

# Generate VAPID keys for Web Push (use a tool like web-push CLI)
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_PUBLIC_KEY

# Admin secret for initial setup
wrangler secret put ADMIN_SECRET_KEY
```

### 5. Deploy

```bash
# Deploy the API worker
cd siliconbeest-worker && npm run deploy

# Deploy the queue consumer
cd siliconbeest-queue-consumer && npm run deploy

# Deploy the frontend
cd siliconbeest-vue && npm run deploy
```

### 6. Configure DNS

Point your domain to the Cloudflare Workers using a custom domain or route in the Cloudflare dashboard.

---

## How to Back Up Data

### D1 Database

Export your D1 database using the Wrangler CLI:

```bash
# Export full database as SQL dump
wrangler d1 export siliconbeest-db --output backup.sql --remote
```

### R2 Media

Use `rclone` or the S3-compatible API to sync R2 contents to a local directory:

```bash
# Using rclone (configure Cloudflare R2 as a remote first)
rclone sync r2:siliconbeest-media ./backup/media/
```

### KV Data

KV namespaces can be listed and exported key-by-key:

```bash
# List all keys
wrangler kv key list --namespace-id <CACHE_NAMESPACE_ID>

# Get a specific key
wrangler kv key get --namespace-id <CACHE_NAMESPACE_ID> "key-name"
```

---

## Maintenance Tasks

### Check Dead Letter Queue

Inspect failed federation delivery messages:

```bash
# View messages in the DLQ (use the Cloudflare dashboard Queues tab
# or consume them with a temporary worker)
```

### Rotate VAPID Keys

If you need to rotate Web Push VAPID keys (this will invalidate all existing push subscriptions):

```bash
cd siliconbeest-worker
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_PUBLIC_KEY
```

### Apply New Migrations

```bash
cd siliconbeest-worker

# Create a new migration
wrangler d1 migrations create siliconbeest-db description_of_change

# Edit the generated SQL file in migrations/

# Apply locally first
wrangler d1 migrations apply siliconbeest-db --local

# Then apply to production
wrangler d1 migrations apply siliconbeest-db --remote
```
