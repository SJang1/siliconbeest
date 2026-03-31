# SiliconBeest Email Sender

Dedicated email-sending worker for SiliconBeest. This Cloudflare Worker consumes email jobs from the `siliconbeest-email` queue and sends them via SMTP using [worker-mailer](https://github.com/nicepkg/worker-mailer).

---

## What It Does

- Consumes `send_email` messages from the dedicated email queue.
- Reads SMTP configuration from environment variables or the D1 `settings` table.
- Sends transactional email (password resets, notification emails) via SMTP.
- Retries failed deliveries up to 3 times via the Cloudflare Queues retry mechanism.

---

## How It Works

1. The main API worker (`siliconbeest`) enqueues a `SendEmailMessage` to its `QUEUE_EMAIL` producer binding whenever email needs to be sent (password reset, admin email, etc.).
2. This worker picks up the message from the `siliconbeest-email` queue.
3. SMTP configuration is resolved with the following priority:
   - **Environment variables** (`SMTP_HOST`, `SMTP_PORT`, etc.) -- checked first
   - **D1 settings table** (`smtp_host`, `smtp_port`, etc.) -- fallback
4. If no SMTP configuration is found, the message is acknowledged and dropped with a warning log.
5. On success, the message is acknowledged (`msg.ack()`). On failure, it is retried (`msg.retry()`).

---

## Message Format

```typescript
interface EmailMessage {
  type: 'send_email';
  to: string;        // Recipient email address
  subject: string;   // Email subject line
  html: string;      // HTML body content
  text?: string;     // Optional plain text body
}
```

---

## Configuration

### Cloudflare Bindings (`wrangler.jsonc`)

| Binding | Service | Purpose |
| ------- | ------- | ------- |
| `DB`    | D1      | Read SMTP settings from the `settings` table |

### Queue Consumer Settings

| Queue               | Max Retries |
| ------------------- | ----------- |
| `siliconbeest-email`| 3           |

### SMTP Configuration

SMTP settings can be provided via environment variables (secrets) or stored in the D1 `settings` table. Environment variables take priority.

**Option 1: Environment variables** (set via `wrangler secret put`)

| Variable         | Description                          | Default   |
| ---------------- | ------------------------------------ | --------- |
| `SMTP_HOST`      | SMTP server hostname                 | (required)|
| `SMTP_PORT`      | SMTP server port                     | `587`     |
| `SMTP_USER`      | SMTP authentication username         |           |
| `SMTP_PASS`      | SMTP authentication password         |           |
| `SMTP_FROM`      | Sender email address                 | `noreply@localhost` |
| `SMTP_SECURE`    | Use TLS (`true` for port 465)        | auto      |
| `SMTP_AUTH_TYPE`  | Auth method: `plain`, `login`, `cram-md5`, or `auto` | `auto` |

**Option 2: D1 settings table**

The worker queries `SELECT key, value FROM settings WHERE key LIKE 'smtp_%'` and maps keys like `smtp_host`, `smtp_port`, `smtp_username`, `smtp_password`, `smtp_from_address`, `smtp_secure`, `smtp_auth_type`.

These settings can be managed through the admin API (`PUT /api/v1/admin/settings`).

---

## Deployment

The email sender is deployed alongside the other workers by the standard scripts:

```bash
# Full deploy (all workers)
./scripts/deploy.sh

# Or deploy individually
cd siliconbeest-email-sender && wrangler deploy
```

The `setup.sh` script automatically creates the `siliconbeest-email` queue and configures the D1 database binding.

---

## Local Development

```bash
npm install
npm run dev
```

This starts `wrangler dev` with local D1 and Queue emulation. Messages enqueued by the main worker (also running via `wrangler dev`) will be delivered to this consumer in the local environment.

To test email sending locally, configure SMTP environment variables:

```bash
# Set local SMTP config (e.g., using a service like Mailtrap or MailHog)
wrangler secret put SMTP_HOST --local
wrangler secret put SMTP_USER --local
wrangler secret put SMTP_PASS --local
```

---

## Project Structure

```
src/
  index.ts    # Queue consumer entry point, SMTP config resolution, email sending
```
