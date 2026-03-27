import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Authentication & Registration', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  // -------------------------------------------------------------------
  // POST /api/v1/apps — create OAuth application
  // -------------------------------------------------------------------
  describe('POST /api/v1/apps', () => {
    it('creates an OAuth application and returns client credentials', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test App',
          redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
          scopes: 'read write follow push',
          website: 'https://example.com',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.name).toBe('Test App');
      expect(body.client_id).toBeDefined();
      expect(body.client_secret).toBeDefined();
      expect(body.redirect_uri).toBe('urn:ietf:wg:oauth:2.0:oob');
      expect(body.vapid_key).toBeDefined();
    });

    it('returns 422 when client_name is missing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 422 when redirect_uris is missing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Broken App' }),
      });

      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // POST /api/v1/accounts — register
  // -------------------------------------------------------------------
  describe('POST /api/v1/accounts', () => {
    it('registers a new user (returns confirmation_required)', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'newuser',
          email: 'newuser@test.local',
          password: 'securepassword123',
          agreement: true,
          locale: 'en',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.confirmation_required).toBe(true);
    });

    it('returns 422 for missing fields', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'incomplete' }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 422 for duplicate username', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'newuser',
          email: 'another@test.local',
          password: 'securepassword123',
          agreement: true,
        }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 422 when agreement is false', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'noagree',
          email: 'noagree@test.local',
          password: 'securepassword123',
          agreement: false,
        }),
      });

      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // POST /oauth/token — client_credentials grant
  // -------------------------------------------------------------------
  describe('POST /oauth/token (client_credentials)', () => {
    it('exchanges client credentials for an app-level token', async () => {
      // First create an app
      const appRes = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Token Test App',
          redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
          scopes: 'read',
        }),
      });
      const appBody = await appRes.json<Record<string, any>>();

      const formBody = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appBody.client_id,
        client_secret: appBody.client_secret,
        scope: 'read',
      });

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.scope).toBe('read');
    });

    it('returns 401 for unknown client_id', async () => {
      const formBody = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'nonexistent',
        client_secret: 'doesntmatter',
      });

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // POST /oauth/token — authorization_code grant
  // -------------------------------------------------------------------
  describe('POST /oauth/token (authorization_code)', () => {
    it('returns 400 for missing code', async () => {
      const appRes = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Code App',
          redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
          scopes: 'read',
        }),
      });
      const app = await appRes.json<Record<string, any>>();

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      });

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid authorization code', async () => {
      const appRes = await SELF.fetch(`${BASE}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Bad Code App',
          redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
          scopes: 'read',
        }),
      });
      const app = await appRes.json<Record<string, any>>();

      const formBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        code: 'totally-invalid-code',
      });

      const res = await SELF.fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/accounts/verify_credentials
  // -------------------------------------------------------------------
  describe('GET /api/v1/accounts/verify_credentials', () => {
    it('returns 401 without a token', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`);
      expect(res.status).toBe(401);
    });

    it('returns 401 with an invalid token', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: 'Bearer invalid-token-12345' },
      });
      expect(res.status).toBe(401);
    });

    it('returns the authenticated user with a valid token', async () => {
      const { token } = await createTestUser('authcheck');

      const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
        headers: authHeaders(token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.username).toBe('authcheck');
      expect(body.acct).toBe('authcheck');
      expect(body.source).toBeDefined();
      expect(body.role).toBeDefined();
    });
  });
});
