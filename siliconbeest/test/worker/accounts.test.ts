import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import type { Relationship } from '../../server/worker/types/mastodon';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Accounts API', () => {
  let alice: { accountId: string; userId: string; token: string };
  let bob: { accountId: string; userId: string; token: string };
  let carol: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    alice = await createTestUser('alice');
    bob = await createTestUser('bob');
    carol = await createTestUser('carol');
  });

  // -------------------------------------------------------------------
  // GET /api/v1/accounts/:id
  // -------------------------------------------------------------------
  describe('GET /api/v1/accounts/:id', () => {
    it('returns the account', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${alice.accountId}`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(alice.accountId);
      expect(body.username).toBe('alice');
    });

    it('returns 404 for a non-existent account', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/00000000000000000000000000`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/accounts/:id/statuses
  // -------------------------------------------------------------------
  describe('GET /api/v1/accounts/:id/statuses', () => {
    it('returns an empty array initially', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${alice.accountId}/statuses`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Follow / Unfollow
  // -------------------------------------------------------------------
  describe('Follow and Unfollow', () => {
    it('POST /api/v1/accounts/:id/follow creates a follow relationship', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/follow`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.following).toBe(true);
    });

    it('GET /api/v1/accounts/:id/followers includes the follower', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/followers`, {
        headers: authHeaders(bob.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const aliceInList = body.some((a: any) => a.id === alice.accountId);
      expect(aliceInList).toBe(true);
    });

    it('POST /api/v1/accounts/:id/unfollow removes the follow', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/unfollow`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.following).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Block / Unblock
  // -------------------------------------------------------------------
  describe('Block and Unblock', () => {
    it('POST /api/v1/accounts/:id/block blocks a user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/block`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.blocking).toBe(true);
    });

    it('GET /api/v1/blocks includes the blocked user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/blocks`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const bobBlocked = body.some((a: any) => a.id === bob.accountId);
      expect(bobBlocked).toBe(true);
    });

    it('POST /api/v1/accounts/:id/unblock unblocks a user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/unblock`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.blocking).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Mute / Unmute
  // -------------------------------------------------------------------
  describe('Mute and Unmute', () => {
    it('POST /api/v1/accounts/:id/mute mutes a user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/mute`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.muting).toBe(true);
    });

    it('GET /api/v1/mutes includes the muted user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/mutes`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const bobMuted = body.some((a: any) => a.id === bob.accountId);
      expect(bobMuted).toBe(true);
    });

    it('POST /api/v1/accounts/:id/unmute unmutes a user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/${bob.accountId}/unmute`, {
        method: 'POST',
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.muting).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------
  describe('GET /api/v1/accounts/relationships', () => {
    it('returns batched relationship state for multiple IDs', async () => {
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO follows
           (id, account_id, target_account_id, show_reblogs, notify, languages, created_at, updated_at)
           VALUES ('relationship-batch-follow', ?1, ?2, 0, 1, '["en","ko"]', ?3, ?3)`,
        ).bind(alice.accountId, bob.accountId, now),
        env.DB.prepare(
          `INSERT INTO follows
           (id, account_id, target_account_id, show_reblogs, notify, created_at, updated_at)
           VALUES ('relationship-batch-followed-by', ?1, ?2, 1, 0, ?3, ?3)`,
        ).bind(carol.accountId, alice.accountId, now),
        env.DB.prepare(
          `INSERT INTO follow_requests
           (id, account_id, target_account_id, created_at, updated_at)
           VALUES ('relationship-batch-request', ?1, ?2, ?3, ?3)`,
        ).bind(alice.accountId, carol.accountId, now),
        env.DB.prepare(
          `INSERT INTO blocks (id, account_id, target_account_id, created_at)
           VALUES ('relationship-batch-block', ?1, ?2, ?3)`,
        ).bind(alice.accountId, carol.accountId, now),
        env.DB.prepare(
          `INSERT INTO mutes
           (id, account_id, target_account_id, hide_notifications, expires_at, created_at, updated_at)
           VALUES ('relationship-batch-mute', ?1, ?2, 1, ?3, ?4, ?4)`,
        ).bind(alice.accountId, carol.accountId, future, now),
        env.DB.prepare(
          `INSERT INTO account_pins (id, account_id, target_account_id, created_at)
           VALUES ('relationship-batch-pin', ?1, ?2, ?3)`,
        ).bind(alice.accountId, bob.accountId, now),
        env.DB.prepare(
          `INSERT INTO account_notes
           (id, account_id, target_account_id, comment, created_at, updated_at)
           VALUES ('relationship-batch-note', ?1, ?2, 'Batch note', ?3, ?3)`,
        ).bind(alice.accountId, bob.accountId, now),
      ]);

      const res = await SELF.fetch(
        `${BASE}/api/v1/accounts/relationships?id[]=${bob.accountId}&id[]=${carol.accountId}&id[]=missing-account`,
        { headers: authHeaders(alice.token) },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Relationship[]>();
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({
        id: bob.accountId,
        following: true,
        showing_reblogs: false,
        notifying: true,
        endorsed: true,
        note: 'Batch note',
        languages: ['en', 'ko'],
      });
      expect(body[1]).toMatchObject({
        id: carol.accountId,
        followed_by: true,
        requested: true,
        blocking: true,
        muting: true,
        muting_notifications: true,
      });
    });
  });

  // -------------------------------------------------------------------
  // Update credentials
  // -------------------------------------------------------------------
  describe('PATCH /api/v1/accounts/update_credentials', () => {
    it('updates profile display name', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
        method: 'PATCH',
        headers: authHeaders(alice.token),
        body: JSON.stringify({ display_name: 'Alice Wonderland' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.display_name).toBe('Alice Wonderland');
    });

    it('clears profile metadata when multipart fields_attributes is empty', async () => {
      const setFields = new FormData();
      setFields.append('fields_attributes[0][name]', 'Website');
      setFields.append('fields_attributes[0][value]', 'https://example.com');

      const setRes = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: setFields,
      });
      expect(setRes.status).toBe(200);
      const setBody = await setRes.json<Record<string, any>>();
      expect(setBody.fields).toEqual([
        { name: 'Website', value: 'https://example.com', verified_at: null },
      ]);

      const clearFields = new FormData();
      clearFields.append('fields_attributes', '[]');

      const clearRes = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: clearFields,
      });
      expect(clearRes.status).toBe(200);
      const clearBody = await clearRes.json<Record<string, any>>();
      expect(clearBody.fields).toEqual([]);
      expect(clearBody.source.fields).toEqual([]);
    });

    it('ignores blank profile metadata rows', async () => {
      const fields = new FormData();
      fields.append('fields_attributes[0][name]', '');
      fields.append('fields_attributes[0][value]', '');
      fields.append('fields_attributes[1][name]', 'Website');
      fields.append('fields_attributes[1][value]', 'https://example.com');

      const res = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: fields,
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.fields).toEqual([
        { name: 'Website', value: 'https://example.com', verified_at: null },
      ]);
    });
  });
});
