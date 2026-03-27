import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin Announcements API', () => {
  let admin: { accountId: string; userId: string; token: string };
  let regularUser: { accountId: string; userId: string; token: string };
  let createdId: string;

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('ann_admin', { role: 'admin' });
    regularUser = await createTestUser('ann_user');
  });

  // -------------------------------------------------------------------
  // Auth / access control
  // -------------------------------------------------------------------
  it('returns 401 without auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
      headers: authHeaders(regularUser.token),
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // POST — create
  // -------------------------------------------------------------------
  describe('POST /api/v1/admin/announcements', () => {
    it('creates an announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Server maintenance tonight' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.text).toBe('Server maintenance tonight');
      expect(body.id).toBeDefined();
      expect(body.published).toBe(true);
      expect(body.created_at).toBeDefined();
      createdId = body.id;
    });

    it('creates an unpublished announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Draft announcement', published: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.published).toBe(false);
      expect(body.published_at).toBeNull();
    });

    it('creates an announcement with dates', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          text: 'Scheduled event',
          starts_at: '2099-01-01T00:00:00Z',
          ends_at: '2099-01-02T00:00:00Z',
          all_day: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.starts_at).toBe('2099-01-01T00:00:00Z');
      expect(body.ends_at).toBe('2099-01-02T00:00:00Z');
      expect(body.all_day).toBe(true);
    });

    it('returns 422 when text is missing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // GET — list
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/announcements', () => {
    it('returns a list of announcements', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------
  // GET — single
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/announcements/:id', () => {
    it('returns a single announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.id).toBe(createdId);
    });

    it('returns 404 for non-existent announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/nonexistent`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // PUT — update
  // -------------------------------------------------------------------
  describe('PUT /api/v1/admin/announcements/:id', () => {
    it('updates an announcement text', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'Updated maintenance notice' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.text).toBe('Updated maintenance notice');
    });

    it('returns 404 for non-existent announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/nonexistent`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ text: 'nope' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // DELETE — remove
  // -------------------------------------------------------------------
  describe('DELETE /api/v1/admin/announcements/:id', () => {
    it('deletes an announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/${createdId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);

      // Confirm it is gone
      const check = await SELF.fetch(`${BASE}/api/v1/admin/announcements/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(check.status).toBe(404);
    });

    it('returns 404 for already-deleted announcement', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/announcements/${createdId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------
  it('response has expected shape', async () => {
    // Create one to inspect
    const createRes = await SELF.fetch(`${BASE}/api/v1/admin/announcements`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: JSON.stringify({ text: 'Shape test' }),
    });
    const body = await createRes.json<any>();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('text');
    expect(body).toHaveProperty('published');
    expect(body).toHaveProperty('published_at');
    expect(body).toHaveProperty('starts_at');
    expect(body).toHaveProperty('ends_at');
    expect(body).toHaveProperty('all_day');
    expect(body).toHaveProperty('created_at');
    expect(body).toHaveProperty('updated_at');
    expect(body).toHaveProperty('mentions');
    expect(body).toHaveProperty('tags');
    expect(body).toHaveProperty('emojis');
    expect(body).toHaveProperty('reactions');
  });
});
