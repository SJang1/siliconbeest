import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigration } from './helpers';

async function resetSetupTables() {
  for (const table of ['oauth_access_tokens', 'oauth_applications', 'actor_keys', 'users', 'accounts', 'settings']) {
    try {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    } catch { /* table may not exist yet */ }
  }
}

async function setupRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return SELF.fetch('https://test.siliconbeest.local/api/v1/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      username: 'admin',
      email: 'admin@example.test',
      password: 'securepassword123',
      ...body,
    }),
  });
}

let migrated = false;

describe('initial setup bootstrap', () => {
  beforeEach(async () => {
    if (!migrated) {
      await applyMigration();
      migrated = true;
    }
    await resetSetupTables();
  });

  it('rejects first-admin creation without the setup secret', async () => {
    const res = await setupRequest({});

    expect(res.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>())
      .toMatchObject({ count: 0 });
  });

  it('rejects first-admin creation with an invalid setup secret', async () => {
    const res = await setupRequest({ setup_secret: 'wrong-secret' });

    expect(res.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>())
      .toMatchObject({ count: 0 });
  });

  it('creates the first admin when the setup secret is valid', async () => {
    const res = await setupRequest({ setup_secret: 'test-setup-secret' });

    expect(res.status).toBe(200);
    const body = await res.json<{ access_token?: string; token_type?: string }>();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();

    const user = await env.DB.prepare('SELECT role, approved, confirmed_at FROM users WHERE email = ?1')
      .bind('admin@example.test')
      .first<{ role: string; approved: number; confirmed_at: string | null }>();
    expect(user?.role).toBe('admin');
    expect(user?.approved).toBe(1);
    expect(user?.confirmed_at).toBeTruthy();
  });

  it('accepts the setup secret from the X-Setup-Secret header', async () => {
    const res = await setupRequest({}, { 'X-Setup-Secret': 'test-setup-secret' });

    expect(res.status).toBe(200);
  });

  it('returns 503 when SETUP_SECRET is not configured', async () => {
    const previousSecret = env.SETUP_SECRET;
    env.SETUP_SECRET = '';
    try {
      const res = await setupRequest({ setup_secret: 'test-setup-secret' });
      expect(res.status).toBe(503);
    } finally {
      env.SETUP_SECRET = previousSecret;
    }
  });
});
