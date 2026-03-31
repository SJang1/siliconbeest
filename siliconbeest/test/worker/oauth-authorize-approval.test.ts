import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('OAuth Authorize — App Approval Flow', () => {
  let token: string;
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    await applyMigration();
    const user = await createTestUser('oauth_approve_user');
    token = user.token;

    // Create an OAuth app
    const res = await SELF.fetch(`${BASE}/api/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test OAuth Client',
        redirect_uris: 'https://example.com/callback',
        scopes: 'read write',
        website: 'https://example.com',
      }),
    });
    const app = await res.json<Record<string, any>>();
    clientId = app.client_id;
    clientSecret = app.client_secret;
  });

  it('returns app info as JSON when Accept: application/json with bearer token', async () => {
    const res = await SELF.fetch(
      `${BASE}/oauth/authorize?client_id=${clientId}&redirect_uri=https://example.com/callback&scope=read+write&response_type=code`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.app).toBeDefined();
    expect(body.app.name).toBe('Test OAuth Client');
    expect(body.app.website).toBe('https://example.com');
    expect(body.authenticated).toBe(true);
    expect(body.client_id).toBe(clientId);
    expect(body.requested_scope).toBe('read write');
  });

  it('returns 400 for unknown client_id in JSON mode', async () => {
    const res = await SELF.fetch(
      `${BASE}/oauth/authorize?client_id=nonexistent&redirect_uri=https://example.com/callback&scope=read&response_type=code`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json<Record<string, any>>();
    expect(body.error).toBeDefined();
  });

  it('issues auth code on POST approve with bearer token', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: 'https://example.com/callback',
        scope: 'read write',
        state: 'test_state_123',
        response_type: 'code',
        decision: 'approve',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.redirect_uri).toBeDefined();
    expect(body.redirect_uri).toContain('https://example.com/callback');
    expect(body.redirect_uri).toContain('code=');
    expect(body.redirect_uri).toContain('state=test_state_123');
  });

  it('returns access_denied on POST deny with bearer token', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: 'https://example.com/callback',
        scope: 'read write',
        response_type: 'code',
        decision: 'deny',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.redirect_uri).toBeDefined();
    expect(body.redirect_uri).toContain('error=access_denied');
  });

  it('the issued auth code can be exchanged for a token', async () => {
    // First, approve to get a code
    const approveRes = await SELF.fetch(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: 'https://example.com/callback',
        scope: 'read write',
        response_type: 'code',
        decision: 'approve',
      }),
    });

    const approveBody = await approveRes.json<Record<string, any>>();
    const redirectUrl = new URL(approveBody.redirect_uri);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    // Exchange the code for a token
    const tokenRes = await SELF.fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'https://example.com/callback',
      }).toString(),
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json<Record<string, any>>();
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.token_type).toBe('Bearer');
  });
});
