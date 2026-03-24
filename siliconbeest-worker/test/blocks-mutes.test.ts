import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Blocks and Mutes API', () => {
  let blkAlice: { accountId: string; userId: string; token: string };
  let blkBob: { accountId: string; userId: string; token: string };
  let blkCarol: { accountId: string; userId: string; token: string };
  let mutAlice: { accountId: string; userId: string; token: string };
  let mutBob: { accountId: string; userId: string; token: string };
  let mutCarol: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    blkAlice = await createTestUser('blkalice');
    blkBob = await createTestUser('blkbob');
    blkCarol = await createTestUser('blkcarol');
    mutAlice = await createTestUser('mutalice');
    mutBob = await createTestUser('mutbob');
    mutCarol = await createTestUser('mutcarol');

    // Block both bob and carol
    await SELF.fetch(`${BASE}/api/v1/accounts/${blkBob.accountId}/block`, {
      method: 'POST',
      headers: authHeaders(blkAlice.token),
    });
    await SELF.fetch(`${BASE}/api/v1/accounts/${blkCarol.accountId}/block`, {
      method: 'POST',
      headers: authHeaders(blkAlice.token),
    });

    // Mute both bob and carol
    await SELF.fetch(`${BASE}/api/v1/accounts/${mutBob.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(mutAlice.token),
    });
    await SELF.fetch(`${BASE}/api/v1/accounts/${mutCarol.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(mutAlice.token),
    });
  });

  // -------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------
  describe('GET /api/v1/blocks', () => {
    it('returns blocked accounts', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/blocks`, {
        headers: authHeaders(blkAlice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      const ids = body.map((a: any) => a.id);
      expect(ids).toContain(blkBob.accountId);
      expect(ids).toContain(blkCarol.accountId);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/blocks`);
      expect(res.status).toBe(401);
    });

    it('supports limit pagination', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/blocks?limit=1`, {
        headers: authHeaders(blkAlice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(1);
    });

    it('returns empty array when no blocks', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/blocks`, {
        headers: authHeaders(blkBob.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Mutes
  // -------------------------------------------------------------------
  describe('GET /api/v1/mutes', () => {
    it('returns muted accounts', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/mutes`, {
        headers: authHeaders(mutAlice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      const ids = body.map((a: any) => a.id);
      expect(ids).toContain(mutBob.accountId);
      expect(ids).toContain(mutCarol.accountId);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/mutes`);
      expect(res.status).toBe(401);
    });

    it('supports limit pagination', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/mutes?limit=1`, {
        headers: authHeaders(mutAlice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(1);
    });

    it('returns empty array when no mutes', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/mutes`, {
        headers: authHeaders(mutBob.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });
  });
});
