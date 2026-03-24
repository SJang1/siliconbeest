import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin Rules API', () => {
  let admin: { accountId: string; userId: string; token: string };
  let regularUser: { accountId: string; userId: string; token: string };
  let createdId: string;

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('rules_admin', { role: 'admin' });
    regularUser = await createTestUser('rules_user');
  });

  // -------------------------------------------------------------------
  // Auth / access control
  // -------------------------------------------------------------------
  it('returns 401 without auth for admin rules endpoint', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
      headers: authHeaders(regularUser.token),
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // POST — create rule
  // -------------------------------------------------------------------
  describe('POST /api/v1/admin/rules', () => {
    it('creates a rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Be respectful to all members' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.text).toBe('Be respectful to all members');
      expect(body.id).toBeDefined();
      expect(body.priority).toBe(0);
      expect(body.created_at).toBeDefined();
      createdId = body.id;
    });

    it('creates a rule with custom priority', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'No spam', priority: 10 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.text).toBe('No spam');
      expect(body.priority).toBe(10);
    });

    it('returns 422 when text is missing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it('returns 403 for non-admin on POST', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        method: 'POST',
        headers: authHeaders(regularUser.token),
        body: JSON.stringify({ text: 'Unauthorized rule' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // GET — list rules
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/rules', () => {
    it('returns a list of rules for admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------
  // GET — single rule
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/rules/:id', () => {
    it('returns a single rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.id).toBe(createdId);
      expect(body.text).toBe('Be respectful to all members');
    });

    it('returns 404 for non-existent rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/nonexistent`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // PUT — update rule
  // -------------------------------------------------------------------
  describe('PUT /api/v1/admin/rules/:id', () => {
    it('updates rule text', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Be kind and respectful' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.text).toBe('Be kind and respectful');
    });

    it('updates rule priority', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ priority: 5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.priority).toBe(5);
    });

    it('returns 404 for non-existent rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/nonexistent`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'nope' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-admin on PUT', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(regularUser.token),
        body: JSON.stringify({ text: 'Unauthorized' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // DELETE — remove rule
  // -------------------------------------------------------------------
  describe('DELETE /api/v1/admin/rules/:id', () => {
    it('deletes a rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);

      // Confirm it is gone
      const check = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(check.status).toBe(404);
    });

    it('returns 404 for already-deleted rule', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${createdId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-admin on DELETE', async () => {
      // Create a rule to attempt to delete as non-admin
      const createRes = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Temp rule' }),
      });
      const created = await createRes.json<any>();

      const res = await SELF.fetch(`${BASE}/api/v1/admin/rules/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(regularUser.token),
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------
  it('response has expected shape', async () => {
    const createRes = await SELF.fetch(`${BASE}/api/v1/admin/rules`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: JSON.stringify({ text: 'Shape test rule' }),
    });
    const body = await createRes.json<any>();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('text');
    expect(body).toHaveProperty('priority');
    expect(body).toHaveProperty('created_at');
    expect(body).toHaveProperty('updated_at');
  });

  // -------------------------------------------------------------------
  // Public rules endpoint (GET /api/v1/instance/rules)
  // -------------------------------------------------------------------
  describe('GET /api/v1/instance/rules (public)', () => {
    it('returns rules without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/instance/rules`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
