import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APActivity } from '../../server/worker/types/activitypub';
import { applyMigration, createTestUser } from './helpers';

const actorDocument = vi.hoisted(() => ({
  oldUri: 'https://old.invalid/users/placeholder',
  newUri: 'https://new.invalid/users/placeholder',
}));

vi.mock('../../server/worker/federation/fedify', () => ({
  createFed: vi.fn(() => ({})),
}));

vi.mock('../../server/worker/federation/helpers/send', () => ({
  getFedifyContext: vi.fn(() => ({
    getDocumentLoader: vi.fn(async () => ({})),
    lookupObject: vi.fn(async () => ({
      id: new URL(actorDocument.newUri),
      aliasIds: [new URL(actorDocument.oldUri)],
    })),
  })),
}));

vi.mock('@fedify/fedify/vocab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fedify/fedify/vocab')>();
  return { ...actual, isActor: () => true };
});

import { processMove } from '../../server/worker/federation/inboxProcessors/move';

interface RemoteAccount {
  id: string;
  uri: string;
}

async function insertRemoteAccount(
  prefix: string,
  domain: string,
  suspended: boolean = false,
): Promise<RemoteAccount> {
  const id = `${prefix}_${crypto.randomUUID()}`;
  const username = `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  const uri = `https://${domain}/users/${username}`;
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url, inbox_url,
        suspended_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?2, '', ?4, ?4, ?5, ?6, ?7, ?7)`,
  ).bind(
    id,
    username,
    domain,
    uri,
    `${uri}/inbox`,
    suspended ? now : null,
    now,
  ).run();
  return { id, uri };
}

function moveActivity(oldAccount: RemoteAccount, newAccount: RemoteAccount): APActivity {
  return {
    type: 'Move',
    id: `${oldAccount.uri}/moves/${crypto.randomUUID()}`,
    actor: oldAccount.uri,
    object: oldAccount.uri,
    target: newAccount.uri,
  };
}

describe('federated account Move permissions', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an exact follower inbox and revalidates every automatic re-follow', async () => {
    const eligible = await createTestUser(`move_eligible_${crypto.randomUUID()}`);
    const wrongRecipient = await createTestUser(`move_wrong_${crypto.randomUUID()}`);
    const blocked = await createTestUser(`move_blocked_${crypto.randomUUID()}`);
    const domainBlocked = await createTestUser(`move_domain_${crypto.randomUUID()}`);
    const inactive = await createTestUser(`move_inactive_${crypto.randomUUID()}`);
    const alreadyFollowing = await createTestUser(`move_existing_${crypto.randomUUID()}`);
    const oldAccount = await insertRemoteAccount('move_old', 'old-move.example');
    const newAccount = await insertRemoteAccount('move_new', 'new-move.example');
    const now = new Date().toISOString();

    await env.DB_META_C000.batch([
      ...[eligible, blocked, domainBlocked, inactive, alreadyFollowing].map((follower) =>
        env.DB_META_C000.prepare(
          `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?4)`,
        ).bind(crypto.randomUUID(), follower.accountId, oldAccount.id, now)),
      env.DB_META_C000.prepare(
        `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(crypto.randomUUID(), alreadyFollowing.accountId, newAccount.id, now),
      env.DB_META_C000.prepare(
        `INSERT INTO blocks (id, account_id, target_account_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(crypto.randomUUID(), blocked.accountId, newAccount.id, now),
      env.DB_META_C000.prepare(
        `INSERT INTO user_domain_blocks (id, account_id, domain, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(crypto.randomUUID(), domainBlocked.accountId, 'NEW-MOVE.EXAMPLE', now),
      env.DB_META_C000.prepare(
        'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
      ).bind(now, inactive.accountId),
    ]);

    actorDocument.oldUri = oldAccount.uri;
    actorDocument.newUri = newAccount.uri;
    const activity = moveActivity(oldAccount, newAccount);
    const federationSend = vi.spyOn(env.QUEUE_FEDERATION, 'send');
    const internalSend = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    await processMove(activity, wrongRecipient.accountId);
    const beforeAllowed = await env.DB_META_C000.prepare(
      'SELECT moved_to_account_id FROM accounts WHERE id = ?1',
    ).bind(oldAccount.id).first<{ moved_to_account_id: string | null }>();
    expect(beforeAllowed?.moved_to_account_id).toBeNull();
    expect(federationSend).not.toHaveBeenCalled();

    await processMove(activity, eligible.accountId);
    const afterAllowed = await env.DB_META_C000.prepare(
      'SELECT moved_to_account_id FROM accounts WHERE id = ?1',
    ).bind(oldAccount.id).first<{ moved_to_account_id: string | null }>();
    expect(afterAllowed?.moved_to_account_id).toBe(newAccount.id);

    const { results: requests } = await env.DB_META_C000.prepare(
      `SELECT account_id FROM follow_requests
       WHERE target_account_id = ?1
       ORDER BY account_id`,
    ).bind(newAccount.id).all<{ account_id: string }>();
    expect(requests).toEqual([{ account_id: eligible.accountId }]);
    expect(federationSend).toHaveBeenCalledTimes(1);
    expect(federationSend.mock.calls[0]?.[0]).toMatchObject({
      actorAccountId: eligible.accountId,
      inboxUrl: `${newAccount.uri}/inbox`,
    });
    expect(internalSend).toHaveBeenCalledTimes(1);

    await processMove(activity, eligible.accountId);
    expect(federationSend).toHaveBeenCalledTimes(1);
    expect(internalSend).toHaveBeenCalledTimes(1);
  });

  it('denies an inactive target but accepts a verified Move through the shared inbox', async () => {
    const follower = await createTestUser(`move_shared_${crypto.randomUUID()}`);
    const deniedOld = await insertRemoteAccount('move_denied_old', 'old-denied.example');
    const deniedNew = await insertRemoteAccount('move_denied_new', 'new-denied.example', true);
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(crypto.randomUUID(), follower.accountId, deniedOld.id, now).run();
    actorDocument.oldUri = deniedOld.uri;
    actorDocument.newUri = deniedNew.uri;

    await processMove(moveActivity(deniedOld, deniedNew), follower.accountId);
    const denied = await env.DB_META_C000.prepare(
      'SELECT moved_to_account_id FROM accounts WHERE id = ?1',
    ).bind(deniedOld.id).first<{ moved_to_account_id: string | null }>();
    expect(denied?.moved_to_account_id).toBeNull();

    const sharedOld = await insertRemoteAccount('move_shared_old', 'old-shared.example');
    const sharedNew = await insertRemoteAccount('move_shared_new', 'new-shared.example');
    actorDocument.oldUri = sharedOld.uri;
    actorDocument.newUri = sharedNew.uri;
    await processMove(moveActivity(sharedOld, sharedNew), '');
    const accepted = await env.DB_META_C000.prepare(
      'SELECT moved_to_account_id FROM accounts WHERE id = ?1',
    ).bind(sharedOld.id).first<{ moved_to_account_id: string | null }>();
    expect(accepted?.moved_to_account_id).toBe(sharedNew.id);
  });
});
