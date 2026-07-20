import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { generateImageAltText } from '../../server/worker/services/workersAi';
import { isWorkersAiFeatureEnabled } from '../../server/worker/services/workersAiFeatures';
import { consumeWorkersAiRateLimit } from '../../server/worker/services/workersAiRateLimit';

vi.mock('../../server/worker/services/workersAi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/worker/services/workersAi')>(),
  generateImageAltText: vi.fn(),
}));

vi.mock('../../server/worker/services/workersAiFeatures', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/worker/services/workersAiFeatures')>(),
  isWorkersAiFeatureEnabled: vi.fn(),
}));

vi.mock('../../server/worker/services/workersAiRateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/worker/services/workersAiRateLimit')>(),
  consumeWorkersAiRateLimit: vi.fn(),
}));

const BASE = 'https://test.siliconbeest.local';

type MediaResponse = {
  id: string;
  type: string;
  description: string | null;
  description_generation_status: 'pending' | 'complete' | 'failed' | 'disabled';
  description_generation_error: string | null;
  description_generation_retry_after_seconds: number | null;
};

const MINIMAL_PNG_BYTES = new Uint8Array([
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

describe('Media API', () => {
  let user: { accountId: string; userId: string; token: string };
  let mediaId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('mediauser');
  });

  beforeEach(() => {
    vi.mocked(isWorkersAiFeatureEnabled).mockReset();
    vi.mocked(isWorkersAiFeatureEnabled).mockResolvedValue(false);
    vi.mocked(consumeWorkersAiRateLimit).mockReset();
    vi.mocked(consumeWorkersAiRateLimit).mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    vi.mocked(generateImageAltText).mockReset();
    vi.mocked(generateImageAltText).mockResolvedValue(null);
  });

  // -------------------------------------------------------------------
  // POST /api/v2/media — upload
  // -------------------------------------------------------------------
  describe('POST /api/v2/media', () => {
    it('uploads a media attachment', async () => {
      const formData = new FormData();
      formData.append('file', new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }), 'test.png');
      formData.append('description', 'A test image');

      const res = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });

      // Accept 200 or 202 (async processing)
      expect([200, 202]).toContain(res.status);
      const body = await res.json<MediaResponse>();
      expect(body.id).toBeDefined();
      expect(body.type).toBe('image');
      expect(body.description).toBe('A test image');
      mediaId = body.id;
    });

    it('keeps uploads without descriptions working when Workers AI is unavailable', async () => {
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }),
        'without-alt.png',
      );

      const res = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });

      expect(res.status).toBe(202);
      const body = await res.json<MediaResponse>();
      expect(body.description).toBeNull();
      expect(body.description_generation_status).toBe('disabled');
    });

    it('returns immediately and generates ALT text from uploaded bytes in the background', async () => {
      vi.mocked(isWorkersAiFeatureEnabled).mockResolvedValue(true);
      vi.mocked(generateImageAltText).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'A small red square.';
      });
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }),
        'generated-alt.png',
      );

      const res = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });
      expect(res.status).toBe(202);
      const uploaded = await res.json<MediaResponse>();
      expect(uploaded.description).toBeNull();
      expect(uploaded.description_generation_status).toBe('pending');

      // The real process_media consumer updates this timestamp while reading
      // dimensions. Metadata processing must not invalidate the NULL pending
      // sentinel or discard a valid generated description.
      await env.DB.prepare(
        `UPDATE media_attachments
         SET width = 1, height = 1, updated_at = datetime('now')
         WHERE id = ?1`,
      )
        .bind(uploaded.id)
        .run();

      await vi.waitFor(async () => {
        const statusResponse = await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
          headers: authHeaders(user.token),
        });
        const status = await statusResponse.json<MediaResponse>();
        expect(status.description).toBe('A small red square.');
        expect(status.description_generation_status).toBe('complete');
      });

      expect(isWorkersAiFeatureEnabled).toHaveBeenCalledWith('imageDescription');
      expect(consumeWorkersAiRateLimit).toHaveBeenCalledWith(
        'imageDescription',
        user.accountId,
      );
      expect(generateImageAltText).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'image/png',
        expect.anything(),
      );
    });

    it('reports a stable reason when automatic ALT generation is rate limited', async () => {
      vi.mocked(isWorkersAiFeatureEnabled).mockResolvedValue(true);
      vi.mocked(consumeWorkersAiRateLimit).mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 60,
        reason: 'limited',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }),
        'rate-limited-alt.png',
      );

      const uploadResponse = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });
      const uploaded = await uploadResponse.json<MediaResponse>();

      await vi.waitFor(async () => {
        const statusResponse = await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
          headers: authHeaders(user.token),
        });
        const status = await statusResponse.json<MediaResponse>();
        expect(status.description_generation_status).toBe('failed');
        expect(status.description_generation_error).toBe('rate_limited');
        expect(status.description_generation_retry_after_seconds).toBe(60);
      });
      expect(generateImageAltText).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '[workers-ai]',
        expect.stringContaining('rate_limited'),
      );
    });

    it('never overwrites a manual ALT save made while generation is pending', async () => {
      vi.mocked(isWorkersAiFeatureEnabled).mockResolvedValue(true);
      vi.mocked(generateImageAltText).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'AI description that must not win';
      });
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }),
        'manual-alt.png',
      );

      const uploadResponse = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });
      const uploaded = await uploadResponse.json<MediaResponse>();
      expect(uploaded.description_generation_status).toBe('pending');

      const updateResponse = await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ description: 'My manual description' }),
      });
      expect(updateResponse.status).toBe(200);

      await vi.waitFor(async () => {
        const statusResponse = await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
          headers: authHeaders(user.token),
        });
        const status = await statusResponse.json<MediaResponse>();
        expect(status.description).toBe('My manual description');
        expect(status.description_generation_status).toBe('complete');
      });
    });

    it('treats an explicit blank ALT save as a manual choice', async () => {
      vi.mocked(isWorkersAiFeatureEnabled).mockResolvedValue(true);
      vi.mocked(generateImageAltText).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'AI description that must not replace a blank choice';
      });
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([MINIMAL_PNG_BYTES], { type: 'image/png' }),
        'blank-alt.png',
      );

      const uploadResponse = await SELF.fetch(`${BASE}/api/v2/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });
      const uploaded = await uploadResponse.json<MediaResponse>();

      await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ description: '' }),
      });

      await vi.waitFor(async () => {
        const statusResponse = await SELF.fetch(`${BASE}/api/v1/media/${uploaded.id}`, {
          headers: authHeaders(user.token),
        });
        const status = await statusResponse.json<MediaResponse>();
        expect(status.description).toBeNull();
        expect(status.description_generation_status).toBe('complete');
      });
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
      const body = await res.json<MediaResponse>();
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
      const body = await res.json<MediaResponse>();
      expect(body.description).toBe('Updated alt text');
    });

    it('rejects null descriptions so they cannot impersonate the pending sentinel', async () => {
      if (!mediaId) return;

      const res = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ description: null }),
      });

      expect(res.status).toBe(422);
    });
  });
});
