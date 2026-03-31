import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Auth middleware — suspension & disabled checks', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('returns 401 for a suspended account', async () => {
    const { accountId, token } = await createTestUser('suspended_user');

    // Suspend the account
    await env.DB.prepare(
      "UPDATE accounts SET suspended_at = datetime('now') WHERE id = ?1",
    )
      .bind(accountId)
      .run();

    const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 for a disabled user', async () => {
    const { userId, token } = await createTestUser('disabled_user');

    // Disable the user
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?1')
      .bind(userId)
      .run();

    const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(401);
  });

  it('still allows a normal, active user', async () => {
    const { token } = await createTestUser('active_user');

    const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
  });
});
