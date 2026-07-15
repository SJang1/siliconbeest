import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

async function insertDlqMessage(id: string, status = 'parked', rawBody?: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
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
  const row = await env.DB.prepare(
    'SELECT status FROM federation_dlq_parked WHERE id = ?1',
  ).bind(id).first<{ status: string }>();
  return row?.status ?? null;
}

describe('Admin federation DLQ bulk API', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await applyMigration();
    adminToken = (await createTestUser('dlqbulkadmin', { role: 'admin' })).token;
    userToken = (await createTestUser('dlqbulkuser')).token;
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
    await env.DB.prepare("UPDATE federation_dlq_parked SET status = 'discarded' WHERE status = 'parked'").run();
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
