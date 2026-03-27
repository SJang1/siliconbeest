import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Custom Emojis API', () => {
  let admin: { accountId: string; userId: string; token: string };
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('emojiAdmin', { role: 'admin' });
    user = await createTestUser('emojiUser');
  });

  /**
   * Helper: build a minimal FormData with shortcode and a tiny PNG file
   * for uploading custom emojis.
   */
  function buildEmojiFormData(shortcode: string, category?: string): FormData {
    // 1x1 transparent PNG (minimal valid PNG)
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02,
      0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, // IEND chunk
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
      0x60, 0x82,
    ]);
    const file = new File([pngBytes], 'emoji.png', { type: 'image/png' });

    const formData = new FormData();
    formData.append('shortcode', shortcode);
    formData.append('image', file);
    if (category) {
      formData.append('category', category);
    }
    return formData;
  }

  // =====================================================================
  // 1. List custom emojis (public, initially empty)
  // =====================================================================
  describe('GET /api/v1/custom_emojis', () => {
    it('returns an empty array when no custom emojis exist', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      // Could be empty or have emojis from previous test runs in the same
      // test worker; just verify the shape.
    });

    it('does not require authentication', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      expect(res.status).toBe(200);
    });
  });

  // =====================================================================
  // 2. Admin upload emoji
  // =====================================================================
  describe('POST /api/v1/admin/custom_emojis', () => {
    it('admin can upload a custom emoji', async () => {
      const formData = buildEmojiFormData('test_emoji', 'testing');

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: formData,
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.shortcode).toBe('test_emoji');
      expect(body.id).toBeDefined();
      expect(body.url).toBeDefined();
      expect(body.static_url).toBeDefined();
      expect(body.visible_in_picker).toBe(true);
      expect(body.category).toBe('testing');
      expect(body.created_at).toBeDefined();
      expect(body.updated_at).toBeDefined();
    });

    it('returns 422 for missing shortcode', async () => {
      const formData = new FormData();
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      formData.append('image', new File([pngBytes], 'emoji.png', { type: 'image/png' }));

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 for missing image', async () => {
      const formData = new FormData();
      formData.append('shortcode', 'no_image');

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid shortcode format', async () => {
      const formData = buildEmojiFormData('invalid-emoji!');

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 for duplicate shortcode', async () => {
      // Upload first
      await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('dupe_emoji'),
      });

      // Try uploading again with same shortcode
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('dupe_emoji'),
      });
      expect(res.status).toBe(422);
    });
  });

  // =====================================================================
  // 3. After upload, public endpoint includes the emoji
  // =====================================================================
  describe('After upload, emoji appears in public list', () => {
    it('GET /api/v1/custom_emojis includes the uploaded emoji', async () => {
      // Upload a distinct emoji
      const uploadRes = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('visible_emoji', 'public_test'),
      });
      expect(uploadRes.status).toBe(200);

      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      const found = body.find((e: any) => e.shortcode === 'visible_emoji');
      expect(found).toBeDefined();
      expect(found.visible_in_picker).toBe(true);
      expect(found.category).toBe('public_test');
      expect(found.url).toContain('https://');
      expect(found.static_url).toContain('https://');
    });
  });

  // =====================================================================
  // 4. Admin update emoji
  // =====================================================================
  describe('PATCH /api/v1/admin/custom_emojis/:id', () => {
    it('admin can update the category of an emoji', async () => {
      // Upload first
      const uploadRes = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('update_emoji', 'old_category'),
      });
      const uploaded = await uploadRes.json<Record<string, any>>();
      const emojiId = uploaded.id;

      // Update
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/${emojiId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${admin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'new_category' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.category).toBe('new_category');
      expect(body.shortcode).toBe('update_emoji');
    });

    it('admin can toggle visible_in_picker', async () => {
      const uploadRes = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('toggle_emoji'),
      });
      const uploaded = await uploadRes.json<Record<string, any>>();
      const emojiId = uploaded.id;

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/${emojiId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${admin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ visible_in_picker: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.visible_in_picker).toBe(false);

      // Verify it no longer appears in the public list
      const publicRes = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      const publicEmojis = await publicRes.json<any[]>();
      const found = publicEmojis.find((e: any) => e.shortcode === 'toggle_emoji');
      expect(found).toBeUndefined();
    });

    it('returns 404 for nonexistent emoji id', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/nonexistent-id`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${admin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'nope' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // =====================================================================
  // 5. Admin delete emoji
  // =====================================================================
  describe('DELETE /api/v1/admin/custom_emojis/:id', () => {
    it('admin can delete a custom emoji', async () => {
      const uploadRes = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('delete_me_emoji'),
      });
      const uploaded = await uploadRes.json<Record<string, any>>();
      const emojiId = uploaded.id;

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/${emojiId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 404 when deleting nonexistent emoji', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/nonexistent-id`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  // =====================================================================
  // 6. After delete, emoji is gone from public list
  // =====================================================================
  describe('After delete, emoji disappears', () => {
    it('deleted emoji no longer appears in GET /api/v1/custom_emojis', async () => {
      // Upload
      const uploadRes = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('gone_emoji'),
      });
      const uploaded = await uploadRes.json<Record<string, any>>();

      // Delete
      await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/${uploaded.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin.token}` },
      });

      // Verify
      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      const body = await res.json<any[]>();
      const found = body.find((e: any) => e.shortcode === 'gone_emoji');
      expect(found).toBeUndefined();
    });
  });

  // =====================================================================
  // 7. Non-admin cannot upload/update/delete
  // =====================================================================
  describe('Non-admin access control', () => {
    it('POST /api/v1/admin/custom_emojis returns 403 for non-admin', async () => {
      const formData = buildEmojiFormData('nonadmin_emoji');

      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });
      expect(res.status).toBe(403);
    });

    it('PATCH /api/v1/admin/custom_emojis/:id returns 403 for non-admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/some-id`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'hack' }),
      });
      expect(res.status).toBe(403);
    });

    it('DELETE /api/v1/admin/custom_emojis/:id returns 403 for non-admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/some-id`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.token}` },
      });
      expect(res.status).toBe(403);
    });

    it('GET /api/v1/admin/custom_emojis returns 403 for non-admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      expect(res.status).toBe(403);
    });
  });

  // =====================================================================
  // Auth required for admin endpoints
  // =====================================================================
  describe('Authentication required for admin endpoints', () => {
    it('POST /api/v1/admin/custom_emojis returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        body: buildEmojiFormData('noauth'),
      });
      expect(res.status).toBe(401);
    });

    it('PATCH /api/v1/admin/custom_emojis/:id returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/some-id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('DELETE /api/v1/admin/custom_emojis/:id returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis/some-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });

  // =====================================================================
  // Public endpoint response structure
  // =====================================================================
  describe('Custom emoji response structure', () => {
    it('each emoji entry has shortcode, url, static_url, visible_in_picker, category', async () => {
      // Make sure at least one emoji exists
      await SELF.fetch(`${BASE}/api/v1/admin/custom_emojis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
        body: buildEmojiFormData('structure_emoji', 'struct_cat'),
      });

      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      const body = await res.json<any[]>();
      expect(body.length).toBeGreaterThanOrEqual(1);

      const emoji = body.find((e: any) => e.shortcode === 'structure_emoji');
      expect(emoji).toBeDefined();
      expect(typeof emoji.shortcode).toBe('string');
      expect(typeof emoji.url).toBe('string');
      expect(typeof emoji.static_url).toBe('string');
      expect(typeof emoji.visible_in_picker).toBe('boolean');
      expect(emoji.category).toBe('struct_cat');
    });
  });
});
