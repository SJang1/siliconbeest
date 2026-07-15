import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    DB: { prepare: vi.fn() },
    CACHE: { get: vi.fn(), put: vi.fn() },
    QUEUE_INTERNAL: { send: vi.fn() },
    QUEUE_FEDERATION: { send: vi.fn() },
    INSTANCE_DOMAIN: 'local.example',
  },
  createFed: vi.fn(),
  getSuspendedDomains: vi.fn(),
  pickSignerUsername: vi.fn(),
  ensureInstanceRecord: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../src/fedify', () => ({ createFed: mocks.createFed }));
vi.mock('@fedify/vocab', () => ({
  Collection: class {},
  isActor: vi.fn(() => true),
}));
vi.mock('../../packages/shared/domain-blocks', () => ({
  getSuspendedDomains: mocks.getSuspendedDomains,
}));
vi.mock('../../packages/shared/services/signer', () => ({
  pickSignerUsername: mocks.pickSignerUsername,
}));
vi.mock('../../packages/shared/services/instance', () => ({
  ensureInstanceRecord: mocks.ensureInstanceRecord,
}));

import { handleFetchRemoteStatus } from '../src/handlers/fetchRemoteStatus';
import { handleFetchRemoteAccount } from '../src/handlers/fetchRemoteAccount';
import { handleImportItem } from '../src/handlers/importItem';

beforeEach(() => {
  mocks.env.DB.prepare.mockReset();
  mocks.env.DB.prepare.mockImplementation((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes('SELECT id, fetched_at, suspended_at')) return null;
        throw new Error(`Unexpected D1 first query: ${sql}`);
      },
      run: async () => ({ success: true }),
    }),
  }));
  mocks.env.CACHE.get.mockReset();
  mocks.env.CACHE.get.mockResolvedValue(null);
  mocks.env.CACHE.put.mockReset();
  mocks.env.CACHE.put.mockResolvedValue(undefined);
  mocks.env.QUEUE_INTERNAL.send.mockReset();
  mocks.env.QUEUE_FEDERATION.send.mockReset();
  mocks.createFed.mockReset();
  mocks.getSuspendedDomains.mockReset();
  mocks.pickSignerUsername.mockReset();
  mocks.ensureInstanceRecord.mockReset();
});

describe('queue suspension guards', () => {
  it('does not store an actor whose canonical id is on a suspended domain', async () => {
    mocks.getSuspendedDomains.mockImplementation(
      async (_db: unknown, domains: string[]) => (
        domains.includes('blocked.example')
          ? new Set(['blocked.example'])
          : new Set<string>()
      ),
    );
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async () => ({
          toJsonLd: async () => ({
            id: 'https://blocked.example/users/alice',
            type: 'Person',
            preferredUsername: 'alice',
            inbox: 'https://blocked.example/users/alice/inbox',
          }),
        }),
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://alias.example/@alice',
      forceRefresh: true,
    });

    expect(mocks.getSuspendedDomains).toHaveBeenNthCalledWith(
      1,
      mocks.env.DB,
      ['alias.example'],
    );
    expect(mocks.getSuspendedDomains).toHaveBeenNthCalledWith(
      2,
      mocks.env.DB,
      ['blocked.example'],
    );
    expect(mocks.env.DB.prepare.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO accounts'),
    )).toBe(false);
  });

  it('does not store an actor whose canonical id has no hostname', async () => {
    mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async () => ({
          toJsonLd: async () => ({
            id: 'urn:uuid:4d51a19e-faf1-4a91-bd85-4c4c7b0722c3',
            type: 'Person',
            preferredUsername: 'alice',
            inbox: 'https://alias.example/users/alice/inbox',
          }),
        }),
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://alias.example/@alice',
      forceRefresh: true,
    });

    expect(mocks.getSuspendedDomains).toHaveBeenCalledTimes(1);
    expect(mocks.env.DB.prepare.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO accounts'),
    )).toBe(false);
  });

  it('does not update a local account through a remote actor alias', async () => {
    mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async () => ({
          toJsonLd: async () => ({
            id: 'https://local.example/users/alice',
            type: 'Person',
            preferredUsername: 'alice',
            inbox: 'https://local.example/users/alice/inbox',
          }),
        }),
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://alias.example/@alice',
      forceRefresh: true,
    });

    expect(mocks.getSuspendedDomains).toHaveBeenCalledTimes(1);
    expect(mocks.env.DB.prepare.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO accounts'),
    )).toBe(false);
    expect(mocks.env.CACHE.put).not.toHaveBeenCalled();
    expect(mocks.ensureInstanceRecord).not.toHaveBeenCalled();
  });

  it('does not overwrite a locally suspended canonical actor through an alias', async () => {
    const canonicalUri = 'https://canonical.example/users/alice';
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: (uri: string) => ({
        first: async () => {
          if (!sql.includes('SELECT id, fetched_at, suspended_at')) {
            throw new Error(`Unexpected D1 first query: ${sql}`);
          }
          return uri === canonicalUri
            ? {
              id: 'canonical-account',
              fetched_at: null,
              suspended_at: '2026-07-15T00:00:00.000Z',
            }
            : null;
        },
        run: async () => {
          throw new Error(`Unexpected D1 mutation: ${sql}`);
        },
      }),
    }));
    mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    const lookupObject = vi.fn(async () => ({
      toJsonLd: async () => ({
        id: canonicalUri,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${canonicalUri}/inbox`,
      }),
    }));
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject,
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://alias.example/@alice',
      forceRefresh: true,
    });

    expect(lookupObject).toHaveBeenCalledTimes(2);
    expect(mocks.env.DB.prepare.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO accounts'),
    )).toBe(false);
    expect(mocks.env.CACHE.put).not.toHaveBeenCalled();
    expect(mocks.ensureInstanceRecord).not.toHaveBeenCalled();
  });

  it('checks suspension using the exact normalized URI that will be stored', async () => {
    const requestedUri = 'https://remote.example:443/users/alice';
    const storedUri = 'https://remote.example/users/alice';
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: (uri: string) => ({
        first: async () => {
          if (!sql.includes('SELECT id, fetched_at, suspended_at')) {
            throw new Error(`Unexpected D1 first query: ${sql}`);
          }
          return uri === storedUri
            ? {
              id: 'remote-account',
              fetched_at: null,
              suspended_at: '2026-07-15T00:00:00.000Z',
            }
            : null;
        },
        run: async () => {
          throw new Error(`Unexpected D1 mutation: ${sql}`);
        },
      }),
    }));
    mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    const lookupObject = vi.fn(async () => ({
      toJsonLd: async () => ({
        id: storedUri,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${storedUri}/inbox`,
      }),
    }));
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject,
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: requestedUri,
      forceRefresh: true,
    });

    expect(lookupObject).toHaveBeenCalledTimes(1);
    expect(mocks.env.DB.prepare.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO accounts'),
    )).toBe(false);
    expect(mocks.env.CACHE.put).not.toHaveBeenCalled();
  });

  it('updates an existing actor row to use the canonical domain', async () => {
    const prepared: Array<{
      sql: string;
      bindings: readonly (string | number | null)[];
    }> = [];
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: (...bindings: readonly (string | number | null)[]) => {
        prepared.push({ sql, bindings });
        return {
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    }));
    mocks.env.CACHE.get.mockResolvedValue('{}');
    mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    const canonicalUri = 'https://canonical.example/users/alice';
    const actor = {
      followersId: new URL(`${canonicalUri}/followers`),
      followingId: new URL(`${canonicalUri}/following`),
      getFollowers: async () => ({
        firstId: new URL(`${canonicalUri}/followers?page=1`),
      }),
      getFollowing: async () => ({
        firstId: new URL(`${canonicalUri}/following?page=1`),
      }),
      toJsonLd: async () => ({
        id: canonicalUri,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${canonicalUri}/inbox`,
      }),
    };
    const lookupObject = vi.fn(async () => actor);
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject,
      }),
    });

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://alias.example/@alice',
      forceRefresh: true,
    });

    const upsert = prepared.find(({ sql }) => sql.includes('INSERT INTO accounts'));
    expect(lookupObject).toHaveBeenNthCalledWith(
      2,
      canonicalUri,
      expect.objectContaining({ documentLoader: expect.any(Object) }),
    );
    expect(upsert?.sql).toContain('username = excluded.username');
    expect(upsert?.sql).toContain('domain = excluded.domain');
    expect(upsert?.bindings[2]).toBe('canonical.example');
    expect(mocks.ensureInstanceRecord).toHaveBeenCalledWith(
      mocks.env.DB,
      'canonical.example',
    );
  });

  it('does not create a follow request for a cached account on a suspended domain', async () => {
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: () => ({
        first: async () => {
          if (!sql.includes('FROM accounts')) {
            throw new Error(`Unexpected D1 query: ${sql}`);
          }
          return {
            id: 'remote-account',
            username: 'alice',
            domain: 'blocked.example',
            uri: 'https://blocked.example/users/alice',
            inbox_url: 'https://blocked.example/inbox',
            shared_inbox_url: null,
            locked: 0,
            manually_approves_followers: 0,
          };
        },
      }),
    }));
    mocks.getSuspendedDomains.mockResolvedValue(new Set(['blocked.example']));

    await handleImportItem({
      type: 'import_item',
      acct: 'alice@blocked.example',
      action: 'following',
      accountId: 'local-account',
    });

    expect(mocks.getSuspendedDomains).toHaveBeenCalledWith(
      mocks.env.DB,
      ['blocked.example'],
    );
    expect(mocks.env.DB.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.env.QUEUE_FEDERATION.send).not.toHaveBeenCalled();
  });

  it.each([
    ['a user-blocked target domain', {}, { actor_blocks_target_domain: 1 }],
    ['a disabled importing account', {}, { user_disabled: 1 }],
    ['a memorial target', { memorial: 1 }, {}],
    ['a migrated-away target', { moved_to_account_id: 'new-account' }, {}],
    ['a suspended target', { suspended_at: '2026-07-15T00:00:00.000Z' }, {}],
    ['a target that blocks the importer', {}, { target_blocks_actor: 1 }],
  ])('does not import a follow across %s', async (
    _label,
    targetOverrides,
    actorOverrides,
  ) => {
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes('FROM accounts target')) {
            return {
              id: 'remote-account',
              username: 'alice',
              domain: 'remote.example',
              uri: 'https://remote.example/users/alice',
              inbox_url: 'https://remote.example/inbox',
              shared_inbox_url: null,
              locked: 0,
              manually_approves_followers: 0,
              suspended_at: null,
              memorial: 0,
              moved_to_account_id: null,
              user_approved: null,
              ...targetOverrides,
            };
          }
          if (sql.includes('FROM accounts actor')) {
            return {
              suspended_at: null,
              memorial: 0,
              user_disabled: 0,
              user_approved: 1,
              actor_blocks_target: 0,
              target_blocks_actor: 0,
              actor_blocks_target_domain: 0,
              ...actorOverrides,
            };
          }
          throw new Error(`Unexpected D1 query: ${sql}`);
        },
      }),
    }));
    mocks.getSuspendedDomains.mockResolvedValue(new Set());

    await handleImportItem({
      type: 'import_item',
      acct: 'alice@remote.example',
      action: 'following',
      accountId: 'local-account',
    });

    expect(mocks.env.QUEUE_FEDERATION.send).not.toHaveBeenCalled();
    expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
    expect(mocks.env.DB.prepare).toHaveBeenCalledTimes(2);
  });

  it('does not store a cross-host status attribution', async () => {
    mocks.env.DB.prepare.mockImplementation((sql: string) => ({
      bind: () => ({
        first: async () => {
          if (!sql.includes('FROM statuses')) {
            throw new Error(`Unexpected D1 query: ${sql}`);
          }
          return null;
        },
      }),
    }));
    mocks.getSuspendedDomains.mockImplementation(
      async (_db: unknown, domains: string[]) => (
        domains.includes('blocked.example')
          ? new Set(['blocked.example'])
          : new Set<string>()
      ),
    );
    mocks.pickSignerUsername.mockResolvedValue('local-user');
    mocks.createFed.mockReturnValue({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async () => ({
          toJsonLd: async () => ({
            id: 'https://status-host.example/notes/1',
            type: 'Note',
            attributedTo: 'https://blocked.example/users/alice',
            content: '<p>blocked</p>',
          }),
        }),
      }),
    });

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://status-host.example/notes/1',
    });

    expect(mocks.getSuspendedDomains).toHaveBeenNthCalledWith(
      1,
      mocks.env.DB,
      ['status-host.example'],
    );
    expect(mocks.getSuspendedDomains).toHaveBeenCalledTimes(1);
    expect(mocks.env.DB.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
  });
});
