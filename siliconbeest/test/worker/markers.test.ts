import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Markers API', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('markeruser');
  });

  // -------------------------------------------------------------------
  // Save markers
  // -------------------------------------------------------------------
  describe('POST /api/v1/markers', () => {
    it('saves a home timeline marker', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/markers`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          home: { last_read_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.home).toBeDefined();
      expect(body.home.last_read_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(typeof body.home.version).toBe('number');
    });

    it('saves a notifications marker', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/markers`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          notifications: { last_read_id: '01BX5ZZKBKACTAV9WEVGEMMVRY' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.notifications).toBeDefined();
      expect(body.notifications.last_read_id).toBe('01BX5ZZKBKACTAV9WEVGEMMVRY');
    });

    it('increments version on update', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/markers`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          home: { last_read_id: '01CXYZ0000000000000000NEWID' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.home.version).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Retrieve markers
  // -------------------------------------------------------------------
  describe('GET /api/v1/markers', () => {
    it('returns saved markers', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/markers?timeline[]=home&timeline[]=notifications`,
        { headers: authHeaders(user.token) },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.home).toBeDefined();
      expect(body.home.last_read_id).toBeDefined();
      expect(body.notifications).toBeDefined();
      expect(body.notifications.last_read_id).toBeDefined();
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/markers`);
      expect(res.status).toBe(401);
    });
  });
});
