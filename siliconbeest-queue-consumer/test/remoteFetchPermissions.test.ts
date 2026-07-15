import { beforeEach, describe, expect, it, vi } from 'vitest';

type SqlBinding = string | number | null;

interface PreparedQuery {
  sql: string;
  bindings: SqlBinding[];
}

interface RemoteAccountRow {
  id: string;
  domain?: string;
  fetched_at?: string | null;
  suspended_at: string | null;
}

const mocks = vi.hoisted(() => ({
  env: {
    DB: {
      prepare: vi.fn(),
      batch: vi.fn(),
    },
    CACHE: {
      get: vi.fn(),
      put: vi.fn(),
    },
    QUEUE_INTERNAL: { send: vi.fn() },
    INSTANCE_DOMAIN: 'local.example',
  },
  prepared: [] as PreparedQuery[],
  remoteDocument: {} as Record<string, unknown>,
  accountRow: null as RemoteAccountRow | null,
  insertChanges: 1,
  createFed: vi.fn(),
  getSuspendedDomains: vi.fn(),
  pickSignerUsername: vi.fn(),
  ensureInstanceRecord: vi.fn(),
  lookupRemoteSoftware: vi.fn(),
  getFollowers: vi.fn(),
  getFollowing: vi.fn(),
  isActor: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('@fedify/vocab', () => ({
  Collection: class {},
  isActor: mocks.isActor,
}));
vi.mock('../src/fedify', () => ({ createFed: mocks.createFed }));
vi.mock('../../packages/shared/domain-blocks', () => ({
  getSuspendedDomains: mocks.getSuspendedDomains,
}));
vi.mock('../../packages/shared/services/signer', () => ({
  pickSignerUsername: mocks.pickSignerUsername,
}));
vi.mock('../../packages/shared/services/instance', () => ({
  ensureInstanceRecord: mocks.ensureInstanceRecord,
}));
vi.mock('../src/utils/nodeinfo', () => ({
  lookupRemoteSoftware: mocks.lookupRemoteSoftware,
}));
vi.mock('../src/utils/repository', () => ({
  getUserAgent: () => 'SiliconBeest/Test',
}));

import { handleFetchRemoteAccount } from '../src/handlers/fetchRemoteAccount';
import { handleFetchRemoteStatus } from '../src/handlers/fetchRemoteStatus';

function actorDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://remote.example/users/alice',
    type: 'Person',
    preferredUsername: 'alice',
    inbox: 'https://remote.example/users/alice/inbox',
    ...overrides,
  };
}

function statusDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://remote.example/notes/1',
    type: 'Note',
    attributedTo: 'https://remote.example/users/alice',
    content: '<p>Hello</p>',
    to: 'https://www.w3.org/ns/activitystreams#Public',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.prepared.length = 0;
  mocks.remoteDocument = {};
  mocks.accountRow = null;
  mocks.insertChanges = 1;
  mocks.env.DB.prepare.mockReset();
  mocks.env.DB.batch.mockReset();
  mocks.env.DB.batch.mockResolvedValue([]);
  mocks.env.CACHE.get.mockReset();
  mocks.env.CACHE.get.mockResolvedValue(null);
  mocks.env.CACHE.put.mockReset();
  mocks.env.CACHE.put.mockResolvedValue(undefined);
  mocks.env.QUEUE_INTERNAL.send.mockReset();
  mocks.env.QUEUE_INTERNAL.send.mockResolvedValue(undefined);
  mocks.createFed.mockReset();
  mocks.createFed.mockImplementation(() => ({
    createContext: () => ({
      getDocumentLoader: async () => ({}),
      lookupObject: async () => ({
        followersId: new URL('https://remote.example/users/alice/followers'),
        followingId: new URL('https://remote.example/users/alice/following'),
        getFollowers: mocks.getFollowers,
        getFollowing: mocks.getFollowing,
        toJsonLd: async () => mocks.remoteDocument,
      }),
    }),
  }));
  mocks.getSuspendedDomains.mockReset();
  mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());
  mocks.pickSignerUsername.mockReset();
  mocks.pickSignerUsername.mockResolvedValue('local-user');
  mocks.ensureInstanceRecord.mockReset();
  mocks.ensureInstanceRecord.mockResolvedValue(undefined);
  mocks.lookupRemoteSoftware.mockReset();
  mocks.lookupRemoteSoftware.mockResolvedValue(null);
  mocks.getFollowers.mockReset();
  mocks.getFollowers.mockResolvedValue({
    firstId: new URL('https://remote.example/users/alice/followers?page=1'),
  });
  mocks.getFollowing.mockReset();
  mocks.getFollowing.mockResolvedValue({
    firstId: new URL('https://remote.example/users/alice/following?page=1'),
  });
  mocks.isActor.mockReset();
  mocks.isActor.mockReturnValue(true);

  mocks.env.DB.prepare.mockImplementation((sql: string) => ({
    bind: (...bindings: SqlBinding[]) => {
      mocks.prepared.push({ sql, bindings });
      return {
        first: async () => {
          if (sql.includes('FROM statuses')) return null;
          if (sql.includes('FROM accounts')) return mocks.accountRow;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        run: async () => {
          if (sql.includes('INSERT OR IGNORE INTO accounts')) {
            mocks.accountRow = {
              id: String(bindings[0]),
              domain: String(bindings[2]),
              suspended_at: null,
            };
          }
          return { meta: { changes: mocks.insertChanges } };
        },
      };
    },
  }));
});

describe('remote actor fetch permissions', () => {
  it('does not store an alias whose canonical endpoint does not confirm its identity', async () => {
    const requestedUri = 'https://remote.example/users/alice';
    const canonicalUri = 'https://remote.example/users/mallory';
    const lookupObject = vi.fn(async (uri: string) => ({
      toJsonLd: async () => actorDocument({
        id: uri === requestedUri
          ? canonicalUri
          : 'https://remote.example/users/eve',
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

    expect(lookupObject).toHaveBeenNthCalledWith(
      2,
      canonicalUri,
      expect.objectContaining({ documentLoader: expect.any(Object) }),
    );
    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT INTO accounts'))).toBe(false);
    expect(mocks.ensureInstanceRecord).not.toHaveBeenCalled();
    expect(mocks.getFollowers).not.toHaveBeenCalled();
    expect(mocks.getFollowing).not.toHaveBeenCalled();
  });

  it('does not force-refresh a locally suspended remote actor', async () => {
    mocks.accountRow = {
      id: 'remote-account',
      fetched_at: null,
      suspended_at: '2026-07-15T00:00:00.000Z',
    };

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://remote.example/users/alice',
      forceRefresh: true,
    });

    expect(mocks.createFed).not.toHaveBeenCalled();
    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT INTO accounts'))).toBe(false);
  });

  it('stores a matching active remote actor and repairs placeholder identity fields', async () => {
    mocks.remoteDocument = actorDocument();

    await handleFetchRemoteAccount({
      type: 'fetch_remote_account',
      actorUri: 'https://remote.example/users/alice',
      forceRefresh: true,
    });

    const upsert = mocks.prepared.find(({ sql }) => sql.includes('INSERT INTO accounts'));
    expect(upsert?.sql).toContain('username = excluded.username');
    expect(upsert?.sql).toContain('domain = excluded.domain');
    expect(upsert?.bindings).toContain('alice');
    expect(mocks.ensureInstanceRecord).toHaveBeenCalledWith(
      mocks.env.DB,
      'remote.example',
    );
  });
});

describe('remote status fetch permissions', () => {
  it('fails closed for collection privacy on a placeholder remote author', async () => {
    const status = statusDocument();
    const author = actorDocument();
    mocks.remoteDocument = status;
    mocks.createFed.mockImplementation(() => ({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async (uri: string) => ({
          toJsonLd: async () => uri === 'https://remote.example/users/alice'
            ? author
            : status,
        }),
      }),
    }));

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    const placeholderInsert = mocks.prepared.find(
      ({ sql }) => sql.includes('INSERT OR IGNORE INTO accounts'),
    );
    expect(placeholderInsert?.sql).toContain('hide_collections');
    expect(placeholderInsert?.sql).toContain(
      'VALUES (?, ?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))',
    );
  });

  it.each([
    [
      'a mismatched object id',
      { id: 'https://remote.example/notes/2' },
    ],
    [
      'an unrelated actor host',
      { attributedTo: 'https://elsewhere.example/users/alice' },
    ],
    [
      'a local actor attribution',
      { attributedTo: 'https://local.example/users/alice' },
    ],
  ])('does not store %s', async (_label, overrides) => {
    mocks.remoteDocument = statusDocument(overrides);

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO statuses')))
      .toBe(false);
    expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
  });

  it('does not store a status attributed to a locally suspended remote actor', async () => {
    mocks.remoteDocument = statusDocument();
    mocks.accountRow = {
      id: 'remote-account',
      domain: 'remote.example',
      suspended_at: '2026-07-15T00:00:00.000Z',
    };

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO statuses')))
      .toBe(false);
  });

  it('does not create a placeholder when an unknown attributed resource is not an Actor', async () => {
    mocks.remoteDocument = statusDocument();
    mocks.accountRow = null;
    mocks.isActor.mockReturnValue(false);

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO accounts')))
      .toBe(false);
    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO statuses')))
      .toBe(false);
    expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
  });

  it('stores a status for an unknown author only after verifying its Actor identity', async () => {
    const status = statusDocument();
    const author = actorDocument();
    mocks.remoteDocument = status;
    mocks.accountRow = null;
    mocks.createFed.mockImplementation(() => ({
      createContext: () => ({
        getDocumentLoader: async () => ({}),
        lookupObject: async (uri: string) => ({
          toJsonLd: async () => uri === 'https://remote.example/users/alice'
            ? author
            : status,
        }),
      }),
    }));

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    expect(mocks.env.QUEUE_INTERNAL.send).toHaveBeenCalledWith({
      type: 'fetch_remote_account',
      actorUri: 'https://remote.example/users/alice',
    });
    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO accounts')))
      .toBe(true);
    expect(mocks.prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO statuses')))
      .toBe(true);
  });

  it('stores a matching status attributed to an active same-host remote actor', async () => {
    mocks.remoteDocument = statusDocument();
    mocks.accountRow = {
      id: 'remote-account',
      domain: 'remote.example',
      suspended_at: null,
    };

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    const insert = mocks.prepared.find(
      ({ sql }) => sql.includes('INSERT OR IGNORE INTO statuses'),
    );
    expect(insert?.bindings).toContain('remote-account');
    expect(insert?.bindings).toContain('https://remote.example/notes/1');
  });

  it('does not create derived rows when a concurrent status insert changed no row', async () => {
    mocks.remoteDocument = statusDocument({
      attachment: [{
        type: 'Image',
        url: 'https://remote.example/media/1.png',
      }],
    });
    mocks.accountRow = {
      id: 'remote-account',
      domain: 'remote.example',
      suspended_at: null,
    };
    mocks.insertChanges = 0;

    await handleFetchRemoteStatus({
      type: 'fetch_remote_status',
      statusUri: 'https://remote.example/notes/1',
    });

    expect(mocks.env.DB.batch).not.toHaveBeenCalled();
  });
});
