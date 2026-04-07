import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Polls API', () => {
  let user: { accountId: string; userId: string; token: string };
  let other: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('polluser');
    other = await createTestUser('pollother');
  });

  // -------------------------------------------------------------------
  // Create status with poll
  // -------------------------------------------------------------------
  describe('POST /api/v1/statuses (with poll)', () => {
    let statusId: string;
    let pollId: string;

    it('creates a status with a single-choice poll', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'What is your favorite color?',
          poll: {
            options: ['Red', 'Blue', 'Green'],
            expires_in: 86400,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.poll).toBeDefined();
      expect(body.poll.options).toHaveLength(3);
      expect(body.poll.options[0].title).toBe('Red');
      expect(body.poll.options[1].title).toBe('Blue');
      expect(body.poll.options[2].title).toBe('Green');
      expect(body.poll.multiple).toBe(false);
      expect(body.poll.votes_count).toBe(0);
      expect(body.poll.voters_count).toBe(0);
      expect(body.poll.expires_at).toBeDefined();
      statusId = body.id;
      pollId = body.poll.id;
    });

    it('creates a status with a multiple-choice poll', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Select your hobbies',
          poll: {
            options: ['Reading', 'Gaming', 'Cooking', 'Hiking'],
            expires_in: 3600,
            multiple: true,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.poll).toBeDefined();
      expect(body.poll.multiple).toBe(true);
      expect(body.poll.options).toHaveLength(4);
    });

    // -------------------------------------------------------------------
    // Fetch poll
    // -------------------------------------------------------------------
    it('GET /api/v1/polls/:id returns poll data', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}`, {
        headers: authHeaders(user.token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(pollId);
      expect(body.options).toHaveLength(3);
      expect(body.voted).toBe(false);
      expect(body.own_votes).toBeNull();
    });

    it('returns 404 for non-existent poll', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/nonexistent`, {
        headers: authHeaders(user.token),
      });

      expect(res.status).toBe(404);
    });

    // -------------------------------------------------------------------
    // Vote on poll
    // -------------------------------------------------------------------
    it('POST /api/v1/polls/:id/votes casts a vote', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}/votes`, {
        method: 'POST',
        headers: authHeaders(other.token),
        body: JSON.stringify({ choices: [1] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.voted).toBe(true);
      expect(body.own_votes).toEqual([1]);
      expect(body.votes_count).toBe(1);
      expect(body.voters_count).toBe(1);
      expect(body.options[1].votes_count).toBe(1);
    });

    it('prevents duplicate votes on single-choice poll', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}/votes`, {
        method: 'POST',
        headers: authHeaders(other.token),
        body: JSON.stringify({ choices: [0] }),
      });

      // Should fail — already voted
      expect(res.status).toBe(422);
    });

    it('allows another user to vote', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}/votes`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ choices: [0] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.votes_count).toBe(2);
      expect(body.voters_count).toBe(2);
      expect(body.options[0].votes_count).toBe(1);
      expect(body.options[1].votes_count).toBe(1);
    });

    it('reflects vote status in GET after voting', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}`, {
        headers: authHeaders(other.token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.voted).toBe(true);
      expect(body.own_votes).toEqual([1]);
    });

    it('rejects vote with empty choices', async () => {
      const third = await createTestUser('pollthird');
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}/votes`, {
        method: 'POST',
        headers: authHeaders(third.token),
        body: JSON.stringify({ choices: [] }),
      });

      expect(res.status).toBe(422);
    });

    it('rejects vote with out-of-range choice index', async () => {
      const fourth = await createTestUser('pollfourth');
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}/votes`, {
        method: 'POST',
        headers: authHeaders(fourth.token),
        body: JSON.stringify({ choices: [99] }),
      });

      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // Multiple-choice voting
  // -------------------------------------------------------------------
  describe('Multiple-choice poll voting', () => {
    let multiPollId: string;

    beforeAll(async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Pick all that apply',
          poll: {
            options: ['A', 'B', 'C'],
            expires_in: 86400,
            multiple: true,
          },
        }),
      });
      const body = await res.json<Record<string, any>>();
      multiPollId = body.poll.id;
    });

    it('allows selecting multiple choices', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${multiPollId}/votes`, {
        method: 'POST',
        headers: authHeaders(other.token),
        body: JSON.stringify({ choices: [0, 2] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.voted).toBe(true);
      expect(body.own_votes).toEqual(expect.arrayContaining([0, 2]));
      expect(body.votes_count).toBe(2);
      expect(body.voters_count).toBe(1);
      expect(body.options[0].votes_count).toBe(1);
      expect(body.options[1].votes_count).toBe(0);
      expect(body.options[2].votes_count).toBe(1);
    });

    it('rejects multiple choices on single-choice poll after multi-poll created', async () => {
      // Create a single-choice poll
      const createRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Single choice only',
          poll: {
            options: ['Yes', 'No'],
            expires_in: 86400,
          },
        }),
      });
      const createBody = await createRes.json<Record<string, any>>();
      const singlePollId = createBody.poll.id;

      const res = await SELF.fetch(`${BASE}/api/v1/polls/${singlePollId}/votes`, {
        method: 'POST',
        headers: authHeaders(other.token),
        body: JSON.stringify({ choices: [0, 1] }),
      });

      expect(res.status).toBe(422);
    });
  });

  // -------------------------------------------------------------------
  // Poll in status enrichment
  // -------------------------------------------------------------------
  describe('Poll enrichment in status responses', () => {
    it('includes poll data when fetching a status', async () => {
      const createRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Status with poll',
          poll: {
            options: ['Option 1', 'Option 2'],
            expires_in: 86400,
          },
        }),
      });
      const createBody = await createRes.json<Record<string, any>>();
      const statusId = createBody.id;

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}`, {
        headers: authHeaders(user.token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.poll).toBeDefined();
      expect(body.poll.options).toHaveLength(2);
      expect(body.poll.options[0].title).toBe('Option 1');
      expect(body.poll.options[1].title).toBe('Option 2');
    });
  });

  // -------------------------------------------------------------------
  // Incoming Question (federation simulation)
  // -------------------------------------------------------------------
  describe('Incoming Question (federation DB simulation)', () => {
    it('stores poll data for a remote Question object', async () => {
      const now = new Date().toISOString();
      const remoteAccountId = crypto.randomUUID();
      const statusId = crypto.randomUUID();
      const pollId = crypto.randomUUID();

      // Insert remote account
      await env.DB.prepare(
        `INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6, ?6)`,
      ).bind(remoteAccountId, 'remoteuser', 'remote.example', 'https://remote.example/users/remoteuser', 'https://remote.example/@remoteuser', now).run();

      // Insert status (as if create processor stored it)
      await env.DB.prepare(
        `INSERT INTO statuses (id, uri, url, account_id, content, visibility, local, reply, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'Vote please!', 'public', 0, 0, ?5, ?5)`,
      ).bind(statusId, 'https://remote.example/notes/123', 'https://remote.example/notes/123', remoteAccountId, now).run();

      // Insert poll (as if processQuestionData stored it)
      const options = JSON.stringify([
        { title: 'Cat', votes_count: 5 },
        { title: 'Dog', votes_count: 3 },
      ]);
      await env.DB.prepare(
        `INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, 0, 8, 8, ?4, ?5)`,
      ).bind(pollId, statusId, new Date(Date.now() + 86400000).toISOString(), options, now).run();

      await env.DB.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2').bind(pollId, statusId).run();

      // Fetch the poll via API
      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId}`, {
        headers: authHeaders(user.token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.options[0].title).toBe('Cat');
      expect(body.options[0].votes_count).toBe(5);
      expect(body.options[1].title).toBe('Dog');
      expect(body.options[1].votes_count).toBe(3);
      expect(body.votes_count).toBe(8);
      expect(body.expired).toBe(false);
    });

    it('marks expired remote poll correctly', async () => {
      const now = new Date().toISOString();
      const remoteAccountId2 = crypto.randomUUID();
      const statusId2 = crypto.randomUUID();
      const pollId2 = crypto.randomUUID();

      await env.DB.prepare(
        `INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6, ?6)`,
      ).bind(remoteAccountId2, 'remoteuser2', 'remote2.example', 'https://remote2.example/users/remoteuser2', 'https://remote2.example/@remoteuser2', now).run();

      await env.DB.prepare(
        `INSERT INTO statuses (id, uri, url, account_id, content, visibility, local, reply, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'Expired poll', 'public', 0, 0, ?5, ?5)`,
      ).bind(statusId2, 'https://remote2.example/notes/456', 'https://remote2.example/notes/456', remoteAccountId2, now).run();

      const options = JSON.stringify([
        { title: 'Yes', votes_count: 10 },
        { title: 'No', votes_count: 7 },
      ]);
      // Set expires_at to the past
      await env.DB.prepare(
        `INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, 0, 17, 17, ?4, ?5)`,
      ).bind(pollId2, statusId2, new Date(Date.now() - 3600000).toISOString(), options, now).run();

      await env.DB.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2').bind(pollId2, statusId2).run();

      const res = await SELF.fetch(`${BASE}/api/v1/polls/${pollId2}`, {
        headers: authHeaders(user.token),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.expired).toBe(true);
    });
  });
});
