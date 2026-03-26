/**
 * Comprehensive Visibility & Permission Tests
 *
 * Tests every edge case of status visibility access control.
 *
 * Users:
 * - alice (author of most statuses)
 * - bob (follows alice)
 * - carol (mentioned in some DMs)
 * - dave (stranger, no relationship)
 * - eve (blocked by alice)
 * - frank (another user for DM thread tests)
 *
 * Statuses:
 * - public_1: public by alice
 * - unlisted_1: unlisted by alice
 * - private_1: private (followers-only) by alice
 * - dm_to_carol: DM from alice mentioning carol
 * - dm_to_nobody: DM from alice with no mentions (self-note)
 * - dm_self_authored: DM alice wrote mentioning carol — alice can see even without self-mention
 * - dm_reply_no_mention: DM reply from carol in same conversation, NOT mentioning alice → alice CANNOT see
 * - dm_thread_reply: DM reply to dm_to_carol from frank, NOT mentioning carol → carol CANNOT see
 * - private_by_bob: private by bob (alice is NOT bob's follower)
 */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

describe('Comprehensive Visibility & Permission Controls', () => {
  let alice: { accountId: string; userId: string; token: string };
  let bob: { accountId: string; userId: string; token: string };
  let carol: { accountId: string; userId: string; token: string };
  let dave: { accountId: string; userId: string; token: string };
  let eve: { accountId: string; userId: string; token: string };
  let frank: { accountId: string; userId: string; token: string };

  const IDS = {
    public_1: 'vp_public_0001',
    unlisted_1: 'vp_unlisted_01',
    private_1: 'vp_private_01',
    dm_to_carol: 'vp_dm_carol_01',
    dm_to_nobody: 'vp_dm_nobody01',
    dm_reply_no_mention: 'vp_dm_reply_nm',
    dm_thread_reply_frank: 'vp_dm_frank_01',
    private_by_bob: 'vp_priv_bob_01',
    dm_carol_to_alice: 'vp_dm_c_to_a01',
    public_by_eve: 'vp_pub_eve_001',
  };

  beforeAll(async () => {
    await applyMigration();
    const now = new Date().toISOString();

    alice = await createTestUser('alice');
    bob = await createTestUser('bob');
    carol = await createTestUser('carol');
    dave = await createTestUser('dave');
    eve = await createTestUser('eve');
    frank = await createTestUser('frank');

    // bob follows alice
    await env.DB.prepare(
      "INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at) VALUES ('vf1', ?1, ?2, ?3, ?3)",
    ).bind(bob.accountId, alice.accountId, now).run();

    // alice blocks eve
    await env.DB.prepare(
      "INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES ('vb1', ?1, ?2, ?3)",
    ).bind(alice.accountId, eve.accountId, now).run();

    // Create conversations
    await env.DB.prepare(
      "INSERT INTO conversations (id, created_at, updated_at) VALUES ('vc1', ?1, ?1)",
    ).bind(now).run();
    await env.DB.prepare(
      "INSERT INTO conversations (id, created_at, updated_at) VALUES ('vc2', ?1, ?1)",
    ).bind(now).run();

    const ins = `INSERT INTO statuses (id, uri, url, account_id, text, content, visibility, sensitive, language, conversation_id, in_reply_to_id, in_reply_to_account_id, local, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'en', ?8, ?9, ?10, 1, ?11, ?11)`;

    // === PUBLIC ===
    await env.DB.prepare(ins).bind(
      IDS.public_1, `https://t.local/s/${IDS.public_1}`, `https://t.local/@alice/${IDS.public_1}`,
      alice.accountId, 'Hello world', '<p>Hello world</p>', 'public', 'vc1', null, null, now,
    ).run();

    // === UNLISTED ===
    await env.DB.prepare(ins).bind(
      IDS.unlisted_1, `https://t.local/s/${IDS.unlisted_1}`, `https://t.local/@alice/${IDS.unlisted_1}`,
      alice.accountId, 'Unlisted hello', '<p>Unlisted hello</p>', 'unlisted', 'vc1', null, null, now,
    ).run();

    // === PRIVATE (followers-only) by alice ===
    await env.DB.prepare(ins).bind(
      IDS.private_1, `https://t.local/s/${IDS.private_1}`, `https://t.local/@alice/${IDS.private_1}`,
      alice.accountId, 'Followers only', '<p>Followers only</p>', 'private', 'vc1', null, null, now,
    ).run();

    // === DM from alice TO carol (carol is mentioned) ===
    await env.DB.prepare(ins).bind(
      IDS.dm_to_carol, `https://t.local/s/${IDS.dm_to_carol}`, `https://t.local/@alice/${IDS.dm_to_carol}`,
      alice.accountId, '@carol secret', '<p>@carol secret</p>', 'direct', 'vc1', null, null, now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO mentions (id, status_id, account_id, created_at) VALUES ('vm1', ?1, ?2, ?3)",
    ).bind(IDS.dm_to_carol, carol.accountId, now).run();

    // === DM from alice with NO mentions (self-note) ===
    await env.DB.prepare(ins).bind(
      IDS.dm_to_nobody, `https://t.local/s/${IDS.dm_to_nobody}`, `https://t.local/@alice/${IDS.dm_to_nobody}`,
      alice.accountId, 'Note to self', '<p>Note to self</p>', 'direct', 'vc1', null, null, now,
    ).run();

    // === DM reply from carol in same conversation, NOT mentioning alice ===
    // carol replies to dm_to_carol but doesn't @mention alice
    await env.DB.prepare(ins).bind(
      IDS.dm_reply_no_mention, `https://t.local/s/${IDS.dm_reply_no_mention}`, `https://t.local/@carol/${IDS.dm_reply_no_mention}`,
      carol.accountId, 'Reply without ping', '<p>Reply without ping</p>', 'direct', 'vc1',
      IDS.dm_to_carol, alice.accountId, now,
    ).run();
    // NO mention for alice — she was mentioned in parent but NOT in this reply

    // === DM reply from frank in same conversation, NOT mentioning carol ===
    // frank somehow is in the conversation but doesn't mention carol
    await env.DB.prepare(ins).bind(
      IDS.dm_thread_reply_frank, `https://t.local/s/${IDS.dm_thread_reply_frank}`, `https://t.local/@frank/${IDS.dm_thread_reply_frank}`,
      frank.accountId, 'Frank reply no mention', '<p>Frank reply</p>', 'direct', 'vc1',
      IDS.dm_to_carol, alice.accountId, now,
    ).run();
    // frank mentions alice but NOT carol
    await env.DB.prepare(
      "INSERT INTO mentions (id, status_id, account_id, created_at) VALUES ('vm2', ?1, ?2, ?3)",
    ).bind(IDS.dm_thread_reply_frank, alice.accountId, now).run();

    // === PRIVATE by bob (alice does NOT follow bob) ===
    await env.DB.prepare(ins).bind(
      IDS.private_by_bob, `https://t.local/s/${IDS.private_by_bob}`, `https://t.local/@bob/${IDS.private_by_bob}`,
      bob.accountId, 'Bob private', '<p>Bob private</p>', 'private', 'vc2', null, null, now,
    ).run();

    // === DM from carol TO alice (alice is mentioned) ===
    await env.DB.prepare(ins).bind(
      IDS.dm_carol_to_alice, `https://t.local/s/${IDS.dm_carol_to_alice}`, `https://t.local/@carol/${IDS.dm_carol_to_alice}`,
      carol.accountId, '@alice hey', '<p>@alice hey</p>', 'direct', 'vc2', null, null, now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO mentions (id, status_id, account_id, created_at) VALUES ('vm3', ?1, ?2, ?3)",
    ).bind(IDS.dm_carol_to_alice, alice.accountId, now).run();

    // === Public by eve (alice blocked eve) ===
    await env.DB.prepare(ins).bind(
      IDS.public_by_eve, `https://t.local/s/${IDS.public_by_eve}`, `https://t.local/@eve/${IDS.public_by_eve}`,
      eve.accountId, 'Eve public post', '<p>Eve public post</p>', 'public', 'vc2', null, null, now,
    ).run();
  });

  // =========================================================================
  // PUBLIC
  // =========================================================================
  describe('Public status', () => {
    it('visible without auth', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.public_1}`);
      expect(r.status).toBe(200);
    });
    it('visible to stranger dave', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.public_1}`, { headers: authHeaders(dave.token) });
      expect(r.status).toBe(200);
    });
    it('visible to blocked user eve', async () => {
      // Public posts are still visible even if blocked (Mastodon behavior)
      const r = await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.public_1}`, { headers: authHeaders(eve.token) });
      expect(r.status).toBe(200);
    });
  });

  // =========================================================================
  // UNLISTED
  // =========================================================================
  describe('Unlisted status', () => {
    it('visible without auth', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.unlisted_1}`);
      expect(r.status).toBe(200);
    });
    it('visible to stranger', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.unlisted_1}`, { headers: authHeaders(dave.token) });
      expect(r.status).toBe(200);
    });
  });

  // =========================================================================
  // PRIVATE (followers-only) by alice
  // =========================================================================
  describe('Private status by alice', () => {
    it('NOT visible without auth', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}`)).status).toBe(404);
    });
    it('NOT visible to stranger dave', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}`, { headers: authHeaders(dave.token) })).status).toBe(404);
    });
    it('NOT visible to carol (not a follower of alice)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}`, { headers: authHeaders(carol.token) })).status).toBe(404);
    });
    it('visible to bob (follower of alice)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}`, { headers: authHeaders(bob.token) })).status).toBe(200);
    });
    it('visible to alice (author)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}`, { headers: authHeaders(alice.token) })).status).toBe(200);
    });
  });

  // =========================================================================
  // PRIVATE by bob — alice does NOT follow bob
  // =========================================================================
  describe('Private status by bob (alice does not follow bob)', () => {
    it('NOT visible to alice (not a follower of bob, even though bob follows alice)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_by_bob}`, { headers: authHeaders(alice.token) })).status).toBe(404);
    });
    it('visible to bob (author)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_by_bob}`, { headers: authHeaders(bob.token) })).status).toBe(200);
    });
  });

  // =========================================================================
  // DM: alice → carol (carol mentioned)
  // =========================================================================
  describe('DM from alice mentioning carol', () => {
    it('NOT visible without auth', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`)).status).toBe(404);
    });
    it('NOT visible to dave (stranger)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`, { headers: authHeaders(dave.token) })).status).toBe(404);
    });
    it('NOT visible to bob (follower but not mentioned)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`, { headers: authHeaders(bob.token) })).status).toBe(404);
    });
    it('NOT visible to frank (not mentioned in THIS status)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`, { headers: authHeaders(frank.token) })).status).toBe(404);
    });
    it('visible to carol (mentioned)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`, { headers: authHeaders(carol.token) })).status).toBe(200);
    });
    it('visible to alice (author)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}`, { headers: authHeaders(alice.token) })).status).toBe(200);
    });
  });

  // =========================================================================
  // DM: alice self-note (no mentions)
  // =========================================================================
  describe('DM self-note (no mentions)', () => {
    it('NOT visible to anyone except author', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_nobody}`)).status).toBe(404);
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_nobody}`, { headers: authHeaders(dave.token) })).status).toBe(404);
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_nobody}`, { headers: authHeaders(bob.token) })).status).toBe(404);
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_nobody}`, { headers: authHeaders(carol.token) })).status).toBe(404);
    });
    it('visible ONLY to alice (author)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_nobody}`, { headers: authHeaders(alice.token) })).status).toBe(200);
    });
  });

  // =========================================================================
  // DM reply: carol replies to alice's DM WITHOUT mentioning alice
  // Key test: alice was mentioned in the PARENT but NOT in this reply
  // =========================================================================
  describe('DM reply from carol NOT mentioning alice', () => {
    it('carol (author) can see her own reply', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_reply_no_mention}`, { headers: authHeaders(carol.token) })).status).toBe(200);
    });
    it('alice CANNOT see (mentioned in parent, NOT in this reply)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_reply_no_mention}`, { headers: authHeaders(alice.token) })).status).toBe(404);
    });
    it('bob CANNOT see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_reply_no_mention}`, { headers: authHeaders(bob.token) })).status).toBe(404);
    });
    it('dave CANNOT see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_reply_no_mention}`, { headers: authHeaders(dave.token) })).status).toBe(404);
    });
  });

  // =========================================================================
  // DM reply: frank replies to alice's DM, mentions alice but NOT carol
  // Key test: carol was mentioned in the PARENT but frank's reply mentions only alice
  // =========================================================================
  describe('DM reply from frank mentioning alice but NOT carol', () => {
    it('frank (author) can see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_thread_reply_frank}`, { headers: authHeaders(frank.token) })).status).toBe(200);
    });
    it('alice can see (mentioned in THIS status)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_thread_reply_frank}`, { headers: authHeaders(alice.token) })).status).toBe(200);
    });
    it('carol CANNOT see (mentioned in parent, NOT in frank reply)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_thread_reply_frank}`, { headers: authHeaders(carol.token) })).status).toBe(404);
    });
    it('bob CANNOT see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_thread_reply_frank}`, { headers: authHeaders(bob.token) })).status).toBe(404);
    });
  });

  // =========================================================================
  // DM: carol → alice (alice is mentioned, carol is author)
  // =========================================================================
  describe('DM from carol mentioning alice', () => {
    it('carol (author) can see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_carol_to_alice}`, { headers: authHeaders(carol.token) })).status).toBe(200);
    });
    it('alice can see (mentioned)', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_carol_to_alice}`, { headers: authHeaders(alice.token) })).status).toBe(200);
    });
    it('bob CANNOT see', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_carol_to_alice}`, { headers: authHeaders(bob.token) })).status).toBe(404);
    });
  });

  // =========================================================================
  // CONTEXT visibility — thread view must respect per-status visibility
  // =========================================================================
  describe('Context (thread) visibility', () => {
    it('public status context accessible without auth', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.public_1}/context`)).status).toBe(200);
    });
    it('private status context NOT accessible without auth', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.private_1}/context`)).status).toBe(404);
    });
    it('DM context NOT accessible to non-mentioned user', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}/context`, { headers: authHeaders(dave.token) })).status).toBe(404);
    });
    it('DM context accessible to mentioned user', async () => {
      expect((await SELF.fetch(`https://t.local/api/v1/statuses/${IDS.dm_to_carol}/context`, { headers: authHeaders(carol.token) })).status).toBe(200);
    });
  });

  // =========================================================================
  // ACCOUNT STATUSES — visibility filtering in lists
  // =========================================================================
  describe('Account statuses visibility filtering', () => {
    it('no auth: alice statuses show only public + unlisted', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/accounts/${alice.accountId}/statuses`);
      const data = await r.json() as any[];
      const vis = data.map((s: any) => s.visibility);
      expect(vis).toContain('public');
      expect(vis).toContain('unlisted');
      expect(vis).not.toContain('private');
      expect(vis).not.toContain('direct');
    });

    it('dave (stranger): only public + unlisted', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/accounts/${alice.accountId}/statuses`, { headers: authHeaders(dave.token) });
      const data = await r.json() as any[];
      const vis = data.map((s: any) => s.visibility);
      expect(vis).not.toContain('private');
      expect(vis).not.toContain('direct');
    });

    it('bob (follower): public + unlisted + private, no direct', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/accounts/${alice.accountId}/statuses`, { headers: authHeaders(bob.token) });
      const data = await r.json() as any[];
      const vis = data.map((s: any) => s.visibility);
      expect(vis).toContain('public');
      expect(vis).toContain('private');
      expect(vis).not.toContain('direct');
    });

    it('alice (author): sees ALL including direct', async () => {
      const r = await SELF.fetch(`https://t.local/api/v1/accounts/${alice.accountId}/statuses`, { headers: authHeaders(alice.token) });
      const data = await r.json() as any[];
      const vis = data.map((s: any) => s.visibility);
      expect(vis).toContain('public');
      expect(vis).toContain('unlisted');
      expect(vis).toContain('private');
      expect(vis).toContain('direct');
    });
  });

  // =========================================================================
  // EDGE CASE: 404 for nonexistent status
  // =========================================================================
  describe('Edge cases', () => {
    it('returns 404 for nonexistent status ID', async () => {
      expect((await SELF.fetch('https://t.local/api/v1/statuses/DOESNOTEXIST')).status).toBe(404);
    });
    it('returns 404 for nonexistent status with auth', async () => {
      expect((await SELF.fetch('https://t.local/api/v1/statuses/DOESNOTEXIST', { headers: authHeaders(alice.token) })).status).toBe(404);
    });
  });
});
