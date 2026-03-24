import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin Domain Blocks API', () => {
  let admin: { accountId: string; userId: string; token: string };
  let regularUser: { accountId: string; userId: string; token: string };
  let createdId: string;

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('db_admin', { role: 'admin' });
    regularUser = await createTestUser('db_user');
  });

  // -------------------------------------------------------------------
  // Auth / access control
  // -------------------------------------------------------------------
  it('returns 401 without auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
      headers: authHeaders(regularUser.token),
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // POST — create domain block
  // -------------------------------------------------------------------
  describe('POST /api/v1/admin/domain_blocks', () => {
    it('creates a domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          domain: 'evil.example.com',
          severity: 'suspend',
          public_comment: 'Spam domain',
          private_comment: 'Internal note',
          reject_media: true,
          reject_reports: true,
          obfuscate: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.domain).toBe('evil.example.com');
      expect(body.severity).toBe('suspend');
      expect(body.public_comment).toBe('Spam domain');
      expect(body.private_comment).toBe('Internal note');
      expect(body.reject_media).toBe(true);
      expect(body.reject_reports).toBe(true);
      expect(body.obfuscate).toBe(true);
      expect(body.id).toBeDefined();
      createdId = body.id;
    });

    it('creates a domain block with defaults', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ domain: 'spam.example.org' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.severity).toBe('silence');
      expect(body.reject_media).toBe(false);
      expect(body.reject_reports).toBe(false);
      expect(body.obfuscate).toBe(false);
    });

    it('returns 422 when domain is missing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 for duplicate domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ domain: 'evil.example.com' }),
      });
      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // GET — list domain blocks
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/domain_blocks', () => {
    it('returns a list of domain blocks', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------
  // GET — single domain block
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/domain_blocks/:id', () => {
    it('returns a single domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.id).toBe(createdId);
      expect(body.domain).toBe('evil.example.com');
    });

    it('returns 404 for non-existent domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/nonexistent`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // PUT — update domain block
  // -------------------------------------------------------------------
  describe('PUT /api/v1/admin/domain_blocks/:id', () => {
    it('updates severity', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ severity: 'silence' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.severity).toBe('silence');
      // Other fields should remain unchanged
      expect(body.reject_media).toBe(true);
    });

    it('updates comments', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          public_comment: 'Updated comment',
          private_comment: 'Updated private',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.public_comment).toBe('Updated comment');
      expect(body.private_comment).toBe('Updated private');
    });

    it('returns 404 for non-existent domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/nonexistent`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ severity: 'suspend' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // DELETE — remove domain block
  // -------------------------------------------------------------------
  describe('DELETE /api/v1/admin/domain_blocks/:id', () => {
    it('deletes a domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);

      // Confirm it is gone
      const check = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
        headers: authHeaders(admin.token),
      });
      expect(check.status).toBe(404);
    });

    it('returns 404 for already-deleted domain block', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks/${createdId}`, {
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
    const createRes = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: JSON.stringify({ domain: 'shape-test.example.com' }),
    });
    const body = await createRes.json<any>();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('domain');
    expect(body).toHaveProperty('severity');
    expect(body).toHaveProperty('reject_media');
    expect(body).toHaveProperty('reject_reports');
    expect(body).toHaveProperty('private_comment');
    expect(body).toHaveProperty('public_comment');
    expect(body).toHaveProperty('obfuscate');
    expect(body).toHaveProperty('created_at');
  });
});
