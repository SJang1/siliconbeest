import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const actorDocument = vi.hoisted(() => ({
  id: 'https://resolver.invalid/users/placeholder',
  username: 'placeholder',
}));

vi.mock('../../server/worker/federation/fedify', () => ({
  createFed: vi.fn(() => ({})),
}));

vi.mock('../../server/worker/federation/helpers/send', () => ({
  getFedifyContext: vi.fn(() => ({
    getDocumentLoader: vi.fn(async () => ({})),
    lookupObject: vi.fn(async () => ({
      id: new URL(actorDocument.id),
      preferredUsername: actorDocument.username,
      name: actorDocument.username,
      summary: '',
      url: new URL(actorDocument.id),
      inboxId: new URL(`${actorDocument.id}/inbox`),
      endpoints: null,
      followersId: new URL(`${actorDocument.id}/followers`),
      followingId: new URL(`${actorDocument.id}/following`),
      getIcon: vi.fn(async () => null),
      getImage: vi.fn(async () => null),
      toJsonLd: vi.fn(async () => ({})),
    })),
  })),
}));

vi.mock('@fedify/fedify/vocab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fedify/fedify/vocab')>();
  return { ...actual, isActor: () => true };
});

import { resolveRemoteAccount } from '../../server/worker/federation/resolveRemoteAccount';

describe('remote account resolver permissions', () => {
  beforeAll(async () => {
    await applyMigration();
    await createTestUser(`resolver_signer_${crypto.randomUUID()}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a fetched actor whose canonical ID differs from the requested identity', async () => {
    const requested = `https://requested.example/users/${crypto.randomUUID()}`;
    actorDocument.id = `https://attacker.example/users/${crypto.randomUUID()}`;
    actorDocument.username = `mismatch_${crypto.randomUUID().replaceAll('-', '')}`;
    const queueSend = vi.spyOn(env.QUEUE_FEDERATION, 'send');

    expect(await resolveRemoteAccount(requested)).toBeNull();
    const stored = await env.DB_META_C000.prepare(
      'SELECT id FROM accounts WHERE uri IN (?1, ?2)',
    ).bind(requested, actorDocument.id).first<{ id: string }>();
    expect(stored).toBeNull();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('rejects local-instance actor documents and suspended cached remotes', async () => {
    const localRequested = `https://${env.INSTANCE_DOMAIN}/users/network-spoof-${crypto.randomUUID()}`;
    actorDocument.id = localRequested;
    actorDocument.username = `local_spoof_${crypto.randomUUID().replaceAll('-', '')}`;
    expect(await resolveRemoteAccount(localRequested)).toBeNull();

    const suspendedId = `resolver_suspended_${crypto.randomUUID()}`;
    const suspendedUri = `https://resolver-suspended.example/users/${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO accounts
         (id, username, domain, display_name, note, uri, url, suspended_at, created_at, updated_at)
       VALUES (?1, ?2, 'resolver-suspended.example', '', '', ?3, ?3, ?4, ?4, ?4)`,
    ).bind(
      suspendedId,
      `suspended_${crypto.randomUUID().replaceAll('-', '')}`,
      suspendedUri,
      now,
    ).run();
    expect(await resolveRemoteAccount(suspendedUri)).toBeNull();
  });

  it('stores an exact active remote actor and reuses only the active remote row', async () => {
    const actorUri = `https://resolver-valid.example/users/${crypto.randomUUID()}`;
    actorDocument.id = actorUri;
    actorDocument.username = `valid_${crypto.randomUUID().replaceAll('-', '')}`;
    const queueSend = vi.spyOn(env.QUEUE_FEDERATION, 'send');

    const accountId = await resolveRemoteAccount(actorUri);
    expect(accountId).not.toBeNull();
    const stored = await env.DB_META_C000.prepare(
      'SELECT uri, domain, suspended_at FROM accounts WHERE id = ?1',
    ).bind(accountId).first<{
      uri: string;
      domain: string | null;
      suspended_at: string | null;
    }>();
    expect(stored).toEqual({
      uri: actorUri,
      domain: 'resolver-valid.example',
      suspended_at: null,
    });
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(await resolveRemoteAccount(actorUri)).toBe(accountId);
  });
});
