import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Quote Posts (FEP-e232)', () => {
  let user: { accountId: string; userId: string; token: string };
  let quotableStatusId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('quoteuser');

    // Create a status to be quoted
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'This is a quotable post', visibility: 'public' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    quotableStatusId = body.id;
  });

  it('creates a status with quote_id and response includes quote object', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Quoting this post',
        quote_id: quotableStatusId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    expect(body.quote).toBeDefined();
    expect(body.quote).not.toBeNull();
    expect(body.quote.id).toBe(quotableStatusId);
    expect(body.quote.content).toContain('quotable post');
  });

  it('quote object includes the quoted status account', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Another quote',
        quote_id: quotableStatusId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    expect(body.quote.account).toBeDefined();
    expect(body.quote.account.username).toBe('quoteuser');
  });

  it('invalid quote_id is ignored gracefully', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Trying to quote nonexistent',
        quote_id: 'NONEXISTENT_ID_12345',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    // Status should be created successfully but with no quote
    expect(body.id).toBeDefined();
    expect(body.quote).toBeNull();
  });
});
