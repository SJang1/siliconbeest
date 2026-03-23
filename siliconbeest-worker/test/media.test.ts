import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Media API', () => {
  let user: { accountId: string; userId: string; token: string };
  let mediaId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('mediauser');
  });

  // -------------------------------------------------------------------
  // POST /api/v2/media — upload
  // -------------------------------------------------------------------
  describe('POST /api/v2/media', () => {
    it('uploads a media attachment', async () => {
      // Create a minimal PNG file (1x1 pixel)
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const formData = new FormData();
      formData.append('file', new Blob([pngBytes], { type: 'image/png' }), 'test.png');
      formData.append('description', 'A test image');

      const res = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });

      // Accept 200 or 202 (async processing)
      expect([200, 202]).toContain(res.status);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBeDefined();
      expect(body.type).toBe('image');
      mediaId = body.id;
    });

    it('returns 401 without auth', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['test'], { type: 'text/plain' }), 'test.txt');

      const res = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        body: formData,
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/media/:id
  // -------------------------------------------------------------------
  describe('GET /api/v1/media/:id', () => {
    it('returns the uploaded media attachment', async () => {
      if (!mediaId) return;

      const res = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(mediaId);
    });

    it('returns 404 for non-existent media', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/media/00000000000000000000000000`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // PUT /api/v1/media/:id — update description
  // -------------------------------------------------------------------
  describe('PUT /api/v1/media/:id', () => {
    it('updates the media description', async () => {
      if (!mediaId) return;

      const res = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ description: 'Updated alt text' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.description).toBe('Updated alt text');
    });
  });
});
