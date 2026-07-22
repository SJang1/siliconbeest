import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

async function insertDlqMessage(id: string, status = 'parked', rawBody?: string) {
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO federation_dlq_parked
      (id, queue, body, message_type, attempts, status, parked_at, updated_at)
     VALUES (?1, 'siliconbeest-federation-dlq', ?2, 'forward_activity', 6, ?3, ?4, ?4)`,
  ).bind(
    id,
    rawBody ?? JSON.stringify({ type: 'forward_activity', activity: { id } }),
    status,
    now,
  ).run();
}

async function getStatus(id: string): Promise<string | null> {
  const row = await env.DB_META_C000.prepare(
    'SELECT status FROM federation_dlq_parked WHERE id = ?1',
  ).bind(id).first<{ status: string }>();
  return row?.status ?? null;
}

describe('Admin federation DLQ API', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await applyMigration();
    adminToken = (await createTestUser('dlqbulkadmin', { role: 'admin' })).token;
    userToken = (await createTestUser('dlqbulkuser')).token;
  });

  it('redacts secrets and authored text from listed message bodies', async () => {
    const rawBody = JSON.stringify({
      type: 'forward_activity',
      rawBody: '{"type":"Create","content":"private post"}',
      originalHeaders: {
        authorization: 'Bearer top-secret-token',
        signature: 'keyId="https://remote.example/actor#main-key",signature="abc"',
        'content-type': 'application/activity+json',
      },
      activity: {
        id: 'https://remote.example/activities/1',
        content: '<p>private post</p>',
        summary: 'private warning',
        source: { content: 'private source', mediaType: 'text/markdown' },
        publicKey: { id: 'https://remote.example/actor#main-key' },
        privateKey: 'private-key-material',
      },
      nested: [{ access_token: 'access-token-value', passwordHash: 'password-hash' }],
    });
    await insertDlqMessage('dlq-redacted-body', 'parked', rawBody);

    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq?status=parked&limit=200`, {
      headers: authHeaders(adminToken),
    });

    expect(res.status).toBe(200);
    const response = await res.json() as { items: Array<{ id: string; body: unknown }> };
    const item = response.items.find((candidate) => candidate.id === 'dlq-redacted-body');
    expect(item?.body).toEqual({
      type: 'forward_activity',
      rawBody: '[REDACTED]',
      originalHeaders: {
        authorization: '[REDACTED]',
        signature: '[REDACTED]',
        'content-type': 'application/activity+json',
      },
      activity: {
        id: 'https://remote.example/activities/1',
        content: '[REDACTED]',
        summary: '[REDACTED]',
        source: '[REDACTED]',
        publicKey: { id: 'https://remote.example/actor#main-key' },
        privateKey: '[REDACTED]',
      },
      nested: [{ access_token: '[REDACTED]', passwordHash: '[REDACTED]' }],
    });

    const stored = await env.DB_META_C000.prepare(
      'SELECT body FROM federation_dlq_parked WHERE id = ?1',
    ).bind('dlq-redacted-body').first<{ body: string }>();
    expect(stored?.body).toBe(rawBody);
  });

  it('does not expose unstructured message bodies', async () => {
    await insertDlqMessage('dlq-unstructured-body', 'parked', 'plain secret text');

    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq?status=parked&limit=200`, {
      headers: authHeaders(adminToken),
    });

    expect(res.status).toBe(200);
    const response = await res.json() as { items: Array<{ id: string; body: unknown }> };
    expect(response.items.find((item) => item.id === 'dlq-unstructured-body')?.body).toBe('[REDACTED]');
  });

  it('discards only the selected parked messages', async () => {
    await insertDlqMessage('dlq-selected-1');
    await insertDlqMessage('dlq-selected-2');
    await insertDlqMessage('dlq-not-selected');

    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq/bulk`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discard', ids: ['dlq-selected-1', 'dlq-selected-2'] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'discard', processed: 2 });
    expect(await getStatus('dlq-selected-1')).toBe('discarded');
    expect(await getStatus('dlq-selected-2')).toBe('discarded');
    expect(await getStatus('dlq-not-selected')).toBe('parked');
  });

  it('replays every parked message and leaves completed messages unchanged', async () => {
    await env.DB_META_C000.prepare("UPDATE federation_dlq_parked SET status = 'discarded' WHERE status = 'parked'").run();
    await insertDlqMessage('dlq-replay-all-1');
    await insertDlqMessage('dlq-replay-all-2');
    await insertDlqMessage('dlq-already-replayed', 'replayed');

    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq/bulk`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'replay', all: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'replay', processed: 2 });
    expect(await getStatus('dlq-replay-all-1')).toBe('replayed');
    expect(await getStatus('dlq-replay-all-2')).toBe('replayed');
    expect(await getStatus('dlq-already-replayed')).toBe('replayed');
  });

  it('replays a parked message even when its body is not valid JSON', async () => {
    await insertDlqMessage('dlq-invalid-json', 'parked', '{not-json');

    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq/bulk`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'replay', ids: ['dlq-invalid-json'] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'replay', processed: 1 });
    expect(await getStatus('dlq-invalid-json')).toBe('replayed');
  });

  it('rejects bulk processing for non-admin users', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/admin/federation/dlq/bulk`, {
      method: 'POST',
      headers: { ...authHeaders(userToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discard', all: true }),
    });

    expect(res.status).toBe(403);
  });
});
