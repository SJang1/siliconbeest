# Seed Admin User

Create the first admin user on a deployed SiliconBeest instance.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI, authenticated (`wrangler login`)
- D1 database already created and migrations applied

## Standalone Script (no repo required)

Download and run directly:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/main/scripts/seed-admin-standalone.sh)
```

The script will interactively prompt for:

| Prompt | Description |
|--------|-------------|
| D1 database name | Name of your D1 database (e.g. `siliconbeest-db`) |
| Instance domain | Your instance's domain (e.g. `social.example.com`) |
| Admin email | Email address for the admin account |
| Admin username | Username for the admin account |
| Admin password | Password (hidden input) |

### What it does

1. Generates a ULID-like ID for the account, user, and actor key
2. Hashes the password with PBKDF2 (100k iterations, SHA-256)
3. Generates an RSA-2048 keypair for ActivityPub federation signing
4. Generates an Ed25519 keypair for additional signing
5. Inserts into 3 D1 tables via `wrangler d1 execute --remote`:
   - `accounts` — the ActivityPub actor
   - `users` — auth record (role=admin, pre-confirmed)
   - `actor_keys` — RSA + Ed25519 keys for federation

## In-repo Script

If you have the repository cloned, use the project-aware version:

```bash
./scripts/seed-admin.sh [email] [username] [password]
```

This reads the D1 database name and instance domain from `config.sh` and `wrangler.jsonc` automatically.

## Full Setup

For a complete instance setup (resources, migrations, secrets, and admin user), use:

```bash
./scripts/setup.sh
```

This runs the admin seeding as part of the full setup flow.
