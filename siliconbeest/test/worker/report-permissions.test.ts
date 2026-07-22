import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type StatusPayload = { id: string };

async function createStatus(
  user: TestUser,
  text: string,
  visibility: 'public' | 'private',
): Promise<StatusPayload> {
  const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({ status: text, visibility }),
  });
  expect(response.status).toBe(200);
  return response.json<StatusPayload>();
}

async function reportCount(accountId: string): Promise<number> {
  const row = await env.DB_META_C000.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE account_id = ?1',
  ).bind(accountId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe('report status permissions', () => {
  let reporter: TestUser;
  let target: TestUser;
  let otherAuthor: TestUser;

  beforeAll(async () => {
    await applyMigration();
    reporter = await createTestUser('permissionreporter');
    target = await createTestUser('permissionreporttarget');
    otherAuthor = await createTestUser('permissionreportother');
  });

  it('rejects hidden and mismatched status references without creating a report', async () => {
    const hidden = await createStatus(target, 'hidden report target', 'private');
    const other = await createStatus(otherAuthor, 'wrong report target account', 'public');
    const before = await reportCount(reporter.accountId);

    for (const statusId of [hidden.id, other.id]) {
      const response = await SELF.fetch(`${BASE}/api/v1/reports`, {
        method: 'POST',
        headers: authHeaders(reporter.token),
        body: JSON.stringify({
          account_id: target.accountId,
          status_ids: [statusId],
          comment: 'must be rejected',
        }),
      });
      expect(response.status).toBe(404);
    }

    expect(await reportCount(reporter.accountId)).toBe(before);
  });

  it('accepts a visible status authored by the reported account', async () => {
    const visible = await createStatus(target, 'visible report target', 'private');
    const followResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(reporter.token),
    });
    expect(followResponse.status).toBe(200);

    const response = await SELF.fetch(`${BASE}/api/v1/reports`, {
      method: 'POST',
      headers: authHeaders(reporter.token),
      body: JSON.stringify({
        account_id: target.accountId,
        status_ids: [visible.id, visible.id],
        comment: 'valid report',
      }),
    });
    expect(response.status).toBe(200);
    const report = await response.json<{ status_ids: string[] }>();
    expect(report.status_ids).toEqual([visible.id]);
  });
});
