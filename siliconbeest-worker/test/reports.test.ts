import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Reports API', () => {
  let user: { accountId: string; userId: string; token: string };
  let target: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('reporter');
    target = await createTestUser('reporttarget');
  });

  describe('POST /api/v1/reports', () => {
    it('creates a report with account_id and comment', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          account_id: target.accountId,
          comment: 'This user is spamming',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBeDefined();
      expect(body.comment).toBe('This user is spamming');
      expect(body.target_account.id).toBe(target.accountId);
      expect(body.action_taken).toBe(false);
    });

    it('returns 422 without account_id', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          comment: 'Missing account_id',
        }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: target.accountId,
          comment: 'No auth',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('includes correct category field', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          account_id: target.accountId,
          comment: 'Spam report',
          category: 'spam',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.category).toBe('spam');
    });

    it('defaults category to other when not specified', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          account_id: target.accountId,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.category).toBe('other');
    });

    it('rejects invalid category', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          account_id: target.accountId,
          category: 'invalid_category',
        }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 404 for non-existent target account', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          account_id: '00000000-0000-0000-0000-000000000000',
        }),
      });

      expect(res.status).toBe(404);
    });
  });
});
