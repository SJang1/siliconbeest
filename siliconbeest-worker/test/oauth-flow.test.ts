import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('OAuth Flow', () => {
  let user: { accountId: string; userId: string; token: string };
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('oauthuser');

    // Register an OAuth application via the API
    const res = await SELF.fetch(`${BASE}/api/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test OAuth App',
        redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
        scopes: 'read write',
      }),
    });
    expect(res.status).toBe(200);
    const app = await res.json<Record<string, any>>();
    clientId = app.client_id;
    clientSecret = app.client_secret;
  });

  // -------------------------------------------------------------------
  // client_credentials grant
  // -------------------------------------------------------------------
  describe('POST /oauth/token with client_credentials', () => {
    let appToken: string;

    it('returns an access_token', async () => {
      const body = new URLSearchParams();
      body.set('grant_type', 'client_credentials');
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
      body.set('scope', 'read');

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      expect(res.status).toBe(200);
      const json = await res.json<Record<string, any>>();
      expect(json.access_token).toBeDefined();
      expect(json.token_type).toBe('Bearer');
      expect(json.scope).toBe('read');
      expect(json.created_at).toBeDefined();
      appToken = json.access_token;
    });

    it('GET /api/v1/apps/verify_credentials succeeds with the token', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps/verify_credentials`, {
        headers: { Authorization: `Bearer ${appToken}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json<Record<string, any>>();
      expect(json.name).toBe('Test OAuth App');
    });
  });

  // -------------------------------------------------------------------
  // Missing / invalid fields
  // -------------------------------------------------------------------
  describe('POST /oauth/token validation', () => {
    it('returns 400 without grant_type', async () => {
      const body = new URLSearchParams();
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 without client_id', async () => {
      const body = new URLSearchParams();
      body.set('grant_type', 'client_credentials');
      body.set('client_secret', clientSecret);

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong client_secret', async () => {
      const body = new URLSearchParams();
      body.set('grant_type', 'client_credentials');
      body.set('client_id', clientId);
      body.set('client_secret', 'wrongsecret');

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      expect(res.status).toBe(401);
    });

    it('returns 400 for unsupported grant_type', async () => {
      const body = new URLSearchParams();
      body.set('grant_type', 'password');
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      expect(res.status).toBe(400);
      const json = await res.json<Record<string, any>>();
      expect(json.error).toBe('unsupported_grant_type');
    });
  });

  // -------------------------------------------------------------------
  // Token revocation
  // -------------------------------------------------------------------
  describe('POST /oauth/revoke', () => {
    let tokenToRevoke: string;

    beforeAll(async () => {
      // Create a fresh token to revoke
      const body = new URLSearchParams();
      body.set('grant_type', 'client_credentials');
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
      body.set('scope', 'read');

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const json = await res.json<Record<string, any>>();
      tokenToRevoke = json.access_token;
    });

    it('revokes the token (returns 200)', async () => {
      const body = new URLSearchParams();
      body.set('token', tokenToRevoke);

      const res = await SELF.fetch(`${BASE}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/apps/verify_credentials with revoked token returns 401', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps/verify_credentials`, {
        headers: { Authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(res.status).toBe(401);
    });

    it('revoke without token still returns 200 (RFC 7009)', async () => {
      const res = await SELF.fetch(`${BASE}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // verify_credentials with existing user token
  // -------------------------------------------------------------------
  describe('GET /api/v1/apps/verify_credentials', () => {
    it('succeeds with a valid user token', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps/verify_credentials`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json<Record<string, any>>();
      expect(json.name).toBe('Test App');
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps/verify_credentials`);
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid token', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps/verify_credentials`, {
        headers: { Authorization: 'Bearer invalidtoken123' },
      });
      expect(res.status).toBe(401);
    });
  });
});
