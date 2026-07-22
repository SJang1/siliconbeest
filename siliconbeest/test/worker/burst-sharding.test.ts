import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeFederatedTime } from '../../../packages/shared/utils/federatedTime';
import { chooseWeightedRendezvousCohort } from '../../server/worker/services/sharding';
import { decodeFeedCursor, encodeFeedCursor } from '../../server/worker/utils/feedCursor';
import { acceptAsyncRegistration } from '../../server/worker/services/asyncRegistration';
import { applyMigration } from './helpers';

beforeAll(async () => { await applyMigration(); });

describe('burst-safe sharding primitives', () => {
  it('assigns a stable cohort and respects zero-order input changes', () => {
    const cohorts = [
      { cohort: 1, weight: 1, catalogVersion: 7 },
      { cohort: 2, weight: 2, catalogVersion: 7 },
      { cohort: 3, weight: 1, catalogVersion: 7 },
    ];
    const first = chooseWeightedRendezvousCohort('operation-123', cohorts);
    const reordered = chooseWeightedRendezvousCohort('operation-123', [...cohorts].reverse());
    expect(reordered.cohort).toBe(first.cohort);
  });

  it('keeps valid remote time, corrects future time, and falls back for invalid input', () => {
    const receivedAtMs = Date.parse('2026-07-22T00:00:00.000Z');
    expect(normalizeFederatedTime('2026-07-21T23:00:00.000Z', receivedAtMs)).toMatchObject({
      publishedAtMs: Date.parse('2026-07-21T23:00:00.000Z'),
      sortAtMs: Date.parse('2026-07-21T23:00:00.000Z'),
      correctedFutureTimestamp: false,
    });
    expect(normalizeFederatedTime('2026-07-22T00:06:00.000Z', receivedAtMs)).toMatchObject({
      sortAtMs: receivedAtMs,
      correctedFutureTimestamp: true,
    });
    expect(normalizeFederatedTime('not-a-date', receivedAtMs)).toMatchObject({
      publishedAtMs: null,
      sortAtMs: receivedAtMs,
    });
  });

  it('signs feed cursors and rejects feed-key substitution', async () => {
    const encoded = await encodeFeedCursor({
      v: 1,
      feedKey: 'home:account-1',
      before: { sortAtMs: 123, entityId: 'entity-1' },
      catalogVersion: 4,
    });
    expect(await decodeFeedCursor(encoded, 'home:account-1')).toMatchObject({
      before: { sortAtMs: 123, entityId: 'entity-1' },
    });
    expect(await decodeFeedCursor(encoded, 'home:account-2')).toBeNull();
  });

  it('serializes one identity reservation and preserves its committed directory mapping', async () => {
    const stub = env.IDENTITY_RESERVATION_DO.getByName('identity-test');
    expect(await stub.reserve('operation-a')).toBe('acquired');
    expect(await stub.reserve('operation-b')).toBe('conflict');
    expect(await stub.commit('operation-a', {
      accountId: 'account-a',
      userId: 'user-a',
      cohort: 0,
      metaOrdinal: 0,
      metaBinding: 'DB_META_C000',
    })).toBe(true);
    expect(await stub.lookup()).toMatchObject({ accountId: 'account-a', userId: 'user-a' });
  });

  it('keeps a delete-before-create tombstone for the asserting actor', async () => {
    const stub = env.REMOTE_OBJECT_JOURNAL_DO.getByName('remote-object-test');
    const deletion = await stub.accept({
      kind: 'Delete', activityId: 'delete-1', actorUri: 'https://remote.example/u/a', sourceTimestampMs: 2,
    });
    const lateCreate = await stub.accept({
      kind: 'Create', activityId: 'create-1', actorUri: 'https://remote.example/u/a', sourceTimestampMs: 1,
    });
    expect(deletion).toMatchObject({ apply: true, tombstoned: true });
    expect(lateCreate).toMatchObject({ apply: false, tombstoned: true });
  });

  it('journals a burst registration with only a password hash before queueing', async () => {
    const operation = await acceptAsyncRegistration({
      email: 'burst-registration@example.com',
      username: 'burst_registration',
      password: 'correct horse battery staple',
      locale: 'en',
      reason: null,
      registrationState: 'awaiting_confirmation',
      registrationMode: 'open',
      redirectUri: null,
      design: 'default',
      invitationToken: null,
      idempotencyKey: 'burst-registration-test',
    });
    const command = await env.REGISTRATION_JOURNAL_DO
      .getByName(operation.operationId).getCommand(operation.operationId);
    expect(operation.state).toBe('queued');
    expect(command?.encryptedPassword).not.toBe('correct horse battery staple');
    expect(command?.encryptedPassword.startsWith('$2')).toBe(true);
  });
});
