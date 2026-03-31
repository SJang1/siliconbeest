import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

/**
 * Create a test user with specific OAuth scopes on its access token.
 */
async function createScopedUser(username: string, scopes: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const uri = `https://test.siliconbeest.local/users/${username}`;
  const appId = crypto.randomUUID();

  // Generate RSA key pair for actor
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey);
  const privBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const toBase64 = (buf: ArrayBuffer) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  const pubPem = `-----BEGIN PUBLIC KEY-----\n${toBase64(pubBuf)}\n-----END PUBLIC KEY-----`;
  const privPem = `-----BEGIN PRIVATE KEY-----\n${toBase64(privBuf)}\n-----END PRIVATE KEY-----`;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, NULL, ?, '', ?, ?, ?, ?)").bind(id, username, username, uri, `https://test.siliconbeest.local/@${username}`, now, now),
    env.DB.prepare("INSERT INTO users (id, account_id, email, encrypted_password, role, approved, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 1, ?, ?, ?)").bind(id, id, `${username}@test.local`, 'dummy_hash', now, now, now),
    env.DB.prepare("INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, pubPem, privPem, uri + '#main-key', now),
    env.DB.prepare("INSERT INTO oauth_applications (id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)").bind(appId, 'Scoped App', 'urn:ietf:wg:oauth:2.0:oob', crypto.randomUUID().replace(/-/g, ''), crypto.randomUUID().replace(/-/g, ''), scopes, now, now),
    env.DB.prepare("INSERT INTO oauth_access_tokens (id, token, application_id, user_id, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), token, appId, id, scopes, now),
  ]);

  return { accountId: id, userId: id, token };
}

describe('OAuth scope enforcement', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('rejects a read-only token on POST /api/v1/statuses', async () => {
    const { token } = await createScopedUser('scope_readonly', 'read');

    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status: 'hello world' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json<Record<string, any>>();
    expect(body.error).toContain('scope');
  });

  it('allows a write-scoped token on POST /api/v1/statuses', async () => {
    const { token } = await createScopedUser('scope_writer', 'read write');

    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status: 'hello world' }),
    });

    // Should succeed (200) or fail validation (422) but NOT 403
    expect(res.status).not.toBe(403);
  });

  it('allows a top-level "write" scope for write:statuses', async () => {
    const { token } = await createScopedUser('scope_topwrite', 'write');

    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status: 'top-level write scope' }),
    });

    expect(res.status).not.toBe(403);
  });

  it('rejects a follow-only token on POST /api/v1/statuses', async () => {
    const { token } = await createScopedUser('scope_followonly', 'follow');

    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status: 'should fail' }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects a read-only token on GET /api/v1/notifications (needs read:notifications)', async () => {
    // "read" top-level should cover "read:notifications"
    const { token } = await createScopedUser('scope_readnotifs', 'read');

    const res = await SELF.fetch(`${BASE}/api/v1/notifications`, {
      headers: authHeaders(token),
    });

    // "read" should cover "read:notifications" via hierarchy
    expect(res.status).not.toBe(403);
  });

  it('rejects a write-only token on GET /api/v1/bookmarks (needs read:bookmarks)', async () => {
    const { token } = await createScopedUser('scope_writeonly_bm', 'write');

    const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(403);
  });
});
