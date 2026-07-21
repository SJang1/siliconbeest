import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const fedifyState = vi.hoisted(() => ({
  actorId: 'https://lookup-remote.example/users/placeholder',
  username: 'placeholder',
  webFingerResult: null as
    | null
    | { links?: Array<{ rel?: string; type?: string; href?: string }> },
  webFingerCalls: [] as string[],
}));

vi.mock('../../server/worker/federation/fedify', () => ({
  createFed: vi.fn(() => ({})),
}));

vi.mock('../../server/worker/federation/helpers/send', () => ({
  getFedifyContext: vi.fn(() => ({
    lookupWebFinger: vi.fn(async (resource: string) => {
      fedifyState.webFingerCalls.push(resource);
      return fedifyState.webFingerResult;
    }),
    getDocumentLoader: vi.fn(async () => ({})),
    lookupObject: vi.fn(async () => ({
      id: new URL(fedifyState.actorId),
      preferredUsername: fedifyState.username,
      name: fedifyState.username,
      summary: '',
      url: new URL(fedifyState.actorId),
      inboxId: new URL(`${fedifyState.actorId}/inbox`),
      endpoints: null,
      followersId: new URL(`${fedifyState.actorId}/followers`),
      followingId: new URL(`${fedifyState.actorId}/following`),
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

import lookupApp from '../../server/worker/endpoints/api/v1/accounts/lookup';
import { errorHandler } from '../../server/worker/middleware/errorHandler';
import type { AppVariables } from '../../server/worker/types';

const BASE = 'https://test.siliconbeest.local';

type AccountEntity = { id: string; acct: string };

function makeApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('federation', {} as AppVariables['federation']);
    await next();
  });
  app.route('/api/v1/accounts', lookupApp);
  app.onError(errorHandler);
  return app;
}

function uniqueName(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function insertRemoteAccount(opts: {
  username: string;
  domain: string;
  fetchedAt: string | null;
}): Promise<{ id: string; uri: string }> {
  const id = crypto.randomUUID();
  const uri = `https://${opts.domain}/users/${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url, fetched_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', '', ?4, ?4, ?5, ?6, ?6)`,
  ).bind(id, opts.username, opts.domain, uri, opts.fetchedAt, now).run();
  return { id, uri };
}

describe('account lookup remote resolution', () => {
  beforeAll(async () => {
    await applyMigration();
    // resolveRemoteAccount needs a local signer for the actor fetch.
    await createTestUser(uniqueName('lookupsigner'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fedifyState.webFingerCalls.length = 0;
    fedifyState.webFingerResult = null;
  });

  it('resolves an uncached remote acct via WebFinger and returns the stored account', async () => {
    const app = makeApp();
    const username = uniqueName('Zeta');
    const domain = 'lookup-remote.example';
    const actorUri = `https://${domain}/users/${crypto.randomUUID()}`;
    fedifyState.actorId = actorUri;
    fedifyState.username = username;
    fedifyState.webFingerResult = {
      links: [{ rel: 'self', type: 'application/activity+json', href: actorUri }],
    };

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`${username}@${domain}`)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<AccountEntity>();
    expect(body.acct).toBe(`${username}@${domain}`);
    expect(fedifyState.webFingerCalls).toContain(`acct:${username}@${domain}`);

    const stored = await env.DB.prepare(
      'SELECT id FROM accounts WHERE uri = ?1',
    ).bind(actorUri).first<{ id: string }>();
    expect(stored).not.toBeNull();
    expect(body.id).toBe(stored!.id);
  });

  it('returns 404 without WebFinger when the acct domain is suspended', async () => {
    const app = makeApp();
    const domain = 'suspended-lookup.example';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
       VALUES (?1, ?2, 'suspend', ?3, ?3)`,
    ).bind(crypto.randomUUID(), domain, now).run();

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`someone@${domain}`)}`,
    );
    expect(res.status).toBe(404);
    expect(fedifyState.webFingerCalls).toHaveLength(0);
  });

  it('returns 404 without WebFinger when the caller has the domain user-blocked', async () => {
    const app = makeApp();
    const blocker = await createTestUser(uniqueName('lookupblocker'));
    const domain = 'user-blocked-lookup.example';
    await env.DB.prepare(
      `INSERT INTO user_domain_blocks (id, account_id, domain) VALUES (?1, ?2, ?3)`,
    ).bind(crypto.randomUUID(), blocker.accountId, domain).run();

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`someone@${domain}`)}`,
      { headers: authHeaders(blocker.token) },
    );
    expect(res.status).toBe(404);
    expect(fedifyState.webFingerCalls).toHaveLength(0);
  });

  it('returns 404 when WebFinger yields no self link', async () => {
    const app = makeApp();
    fedifyState.webFingerResult = { links: [] };

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent('ghost@lookup-remote.example')}`,
    );
    expect(res.status).toBe(404);
    expect(fedifyState.webFingerCalls).toHaveLength(1);
  });

  it('does not attempt WebFinger for unknown local accts', async () => {
    const app = makeApp();
    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${uniqueName('nolocal')}`,
    );
    expect(res.status).toBe(404);
    expect(fedifyState.webFingerCalls).toHaveLength(0);
  });

  it('enqueues a background refresh for stale cached remote accounts', async () => {
    const app = makeApp();
    const username = uniqueName('stalefox');
    const { uri } = await insertRemoteAccount({
      username,
      domain: 'stale-remote.example',
      fetchedAt: '2020-01-01T00:00:00.000Z',
    });
    const sendSpy = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`${username}@stale-remote.example`)}`,
    );
    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fetch_remote_account',
      actorUri: uri,
      forceRefresh: true,
    }));
    expect(fedifyState.webFingerCalls).toHaveLength(0);
  });

  it('does not enqueue a refresh for freshly fetched remote accounts', async () => {
    const app = makeApp();
    const username = uniqueName('freshfox');
    await insertRemoteAccount({
      username,
      domain: 'fresh-remote.example',
      fetchedAt: new Date().toISOString(),
    });
    const sendSpy = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    const res = await app.request(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`${username}@fresh-remote.example`)}`,
    );
    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
