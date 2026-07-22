import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RegistrationCommand } from '../../../packages/shared/types/registration';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin parked operations API', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await applyMigration();
    adminToken = (await createTestUser('parkedopsadmin', { role: 'admin' })).token;
    userToken = (await createTestUser('parkedopsuser')).token;
  });

  it('lists parked operations without storing a command body', async () => {
    await insertParked('parked-list');
    const response = await SELF.fetch(`${BASE}/api/v1/admin/operations/parked`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.find((row) => row.operation_id === 'parked-list')).toMatchObject({
      workload: 'registration',
      status: 'parked',
      target_binding: 'DB_META_C000',
    });
    expect(body.items.some((row) => 'body' in row)).toBe(false);
  });

  it('requires an administrator and discards a parked operation idempotently', async () => {
    await insertParked('parked-discard');
    const forbidden = await SELF.fetch(`${BASE}/api/v1/admin/operations/parked/parked-discard`, {
      method: 'DELETE',
      headers: authHeaders(userToken),
    });
    expect(forbidden.status).toBe(403);

    const response = await SELF.fetch(`${BASE}/api/v1/admin/operations/parked/parked-discard`, {
      method: 'DELETE',
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operation_id: 'parked-discard', status: 'discarded' });

    const duplicate = await SELF.fetch(`${BASE}/api/v1/admin/operations/parked/parked-discard`, {
      method: 'DELETE',
      headers: authHeaders(adminToken),
    });
    expect(duplicate.status).toBe(409);
  });

  it('checks the journal body hash before retrying', async () => {
    const command = registrationCommand('parked-retry');
    const journal = env.REGISTRATION_JOURNAL_DO.getByName(command.operationId);
    await journal.accept(command);
    await journal.update({ operationId: command.operationId, state: 'failed', error: 'poison' });
    const bodyHash = await sha256(JSON.stringify({ type: 'registration', command }));
    await insertParked(command.operationId, bodyHash);

    const response = await SELF.fetch(
      `${BASE}/api/v1/admin/operations/parked/${command.operationId}/retry`,
      { method: 'POST', headers: authHeaders(adminToken) },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ operation_id: command.operationId, status: 'retrying' });
    expect((await journal.getOperation(command.operationId))?.state).toBe('queued');
  });
});

async function insertParked(operationId: string, bodyHash = '0'.repeat(64)): Promise<void> {
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO ops_parked_writes (
       operation_id, workload, body_hash, target_ordinal, target_binding,
       error_class, error, status, parked_at, updated_at
     ) VALUES (?1, 'registration', ?2, 0, 'DB_META_C000', 'Error', 'poison', 'parked', ?3, ?3)`,
  ).bind(operationId, bodyHash, now).run();
}

function registrationCommand(operationId: string): RegistrationCommand {
  return {
    operationId,
    accountId: `${operationId}-account`,
    userId: `${operationId}-user`,
    actorKeyId: `${operationId}-key`,
    email: `${operationId}@example.com`,
    username: operationId,
    encryptedPassword: 'hashed-only',
    locale: 'en',
    reason: null,
    registrationState: 'awaiting_confirmation',
    registrationMode: 'open',
    redirectUri: null,
    design: 'default',
    invitationToken: null,
    shard: { family: 'META', cohort: 0, epoch: 0, ordinal: 0, binding: 'DB_META_C000' },
    acceptedAt: new Date().toISOString(),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
