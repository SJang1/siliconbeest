# Deploy Your Own SiliconBeest Instance

[한국어](README.ko.md)

SiliconBeest is a **GitHub Template Repository**. You can deploy your own Fediverse instance on Cloudflare Workers with automatic upstream updates.

---

## Prerequisites

- A **Workers Enabled** Cloudflare account
- A domain managed by Cloudflare
- [Node.js](https://nodejs.org/) >= 20 (for the setup script only)

---

## Step 1. Create Your Repository

Click **"Use this template"** on [github.com/SJang1/siliconbeest](https://github.com/SJang1/siliconbeest) to create a new repository.

---

## Step 2. Create Cloudflare Resources

Run the following command to create all required Cloudflare resources (D1, R2, KV, Queues):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/HEAD/scripts/install.sh)"
```

The script will prompt for your instance domain, title, and settings, then create all resources and output the values you need for the next step.

> You can also create resources manually via the [Cloudflare dashboard](https://dash.cloudflare.com/) if you prefer.

---

## Step 3. Configure GitHub Secrets & Variables

In your repository's **Settings > Secrets and variables > Actions**:

### Secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers, D1, R2, KV, and Queues permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

### Repository Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PROJECT_PREFIX` | Resource name prefix | `myinstance` |
| `INSTANCE_DOMAIN` | Your instance domain | `social.example.com` |
| `INSTANCE_TITLE` | Display name for your instance | `My Fediverse Server` |
| `REGISTRATION_MODE` | `open`, `approval`, or `closed` | `open` |
| `D1_DATABASE_ID` | D1 database UUID | `7c66942d-...` |
| `KV_CACHE_ID` | KV namespace ID for cache | `14a4d29d...` |
| `KV_SESSIONS_ID` | KV namespace ID for sessions | `b28dd211...` |
| `KV_FEDIFY_ID` | KV namespace ID for Fedify | `cc8fbc2d...` |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_DEPLOY` | `true` | Set `false` to disable auto-deploy on push to main |
| `AUTO_UPDATE_UPSTREAM_DEPLOY` | `true` | Set `false` to sync upstream code only (no deploy after update) |

---

## Step 4. Deploy

Go to **Actions > Deploy > Run workflow** to trigger the first deployment.

The workflow will:
1. Generate wrangler.jsonc files from your GitHub Variables
2. Build the Vue frontend
3. Apply D1 database migrations
4. Deploy all 3 workers (main, queue consumer, email sender)

---

## Step 5. Cloudflare Bot Protection (CRITICAL)

> **Without this step, federation is completely broken.**

Cloudflare's Bot Fight Mode blocks ActivityPub traffic (403 to `/users/*`, `/inbox`). You **must** create a WAF Skip rule that bypasses bot protection for requests with ActivityPub content types (`application/activity+json`, `application/ld+json`) on federation endpoints.

See [scripts/README.md](../../scripts/README.md#cloudflare-bot-protection-critical) for the full WAF rule expression and setup instructions.

---

## Automatic Upstream Updates

Your instance includes a daily workflow (**Sync Upstream & Deploy**) that runs at 00:00 UTC (09:00 KST):

1. Checks for new releases (git tags) in `SJang1/siliconbeest`
2. Merges upstream changes into your `main` branch
3. Applies database migrations and deploys all workers

If a merge conflict occurs, the workflow creates a **GitHub Issue** with manual resolution instructions instead of deploying.

You can also trigger the sync manually:
**Actions > Sync Upstream & Deploy > Run workflow** with `force_deploy` enabled.

---

## Troubleshooting

### "No account id found"
Set `CLOUDFLARE_ACCOUNT_ID` in your GitHub Secrets.

### "dist/client directory does not exist"
The build step failed. Check the build logs for TypeScript or dependency errors.

### Merge conflict on upstream sync
The workflow creates a GitHub Issue automatically. Follow the instructions in the issue to resolve manually:

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git && cd YOUR_REPO
git remote add upstream https://github.com/SJang1/siliconbeest.git
git fetch upstream --tags
git merge upstream/main
# Resolve conflicts, then:
git add -A && git commit
git push
```

### Federation not working (403 errors)
You likely need to configure the Cloudflare WAF Skip rule. See [Step 5](#step-5-cloudflare-bot-protection-critical).
