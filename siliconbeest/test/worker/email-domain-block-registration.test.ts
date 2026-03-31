import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Email domain block registration check', () => {
  beforeAll(async () => {
    await applyMigration();
    // Ensure registration is open
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now'))",
    ).run();
  });

  it('rejects registration when email domain is blocked', async () => {
    // Insert a blocked domain
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO email_domain_blocks (id, domain, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
    ).bind('block1', 'blocked.example', now, now).run();

    const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'blockeduser',
        email: 'user@blocked.example',
        password: 'securepassword123',
        agreement: true,
        locale: 'en',
      }),
    });

    const body = await res.json<Record<string, any>>();

    expect(res.status).toBe(422);
    expect(body.error_description || body.error).toContain('Email domain is not allowed');
  });

  it('allows registration when email domain is not blocked', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alloweduser',
        email: 'user@allowed.example',
        password: 'securepassword123',
        agreement: true,
        locale: 'en',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.confirmation_required).toBe(true);
  });
});
