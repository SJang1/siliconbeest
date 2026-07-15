import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const FEDERATION_API = `${BASE}/api/v1/admin/federation`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describe('Admin federation instance actions', () => {
  let admin: TestUser;
  let moderator: TestUser;

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('federation_instance_admin', { role: 'admin' });
    moderator = await createTestUser('federation_instance_moderator', { role: 'moderator' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps instance reads available to moderators and exposes boolean suspension state', async () => {
    const domain = 'readable.example';
    await insertInstance(domain);
    await insertDomainBlock(domain, 'suspend');

    const listResponse = await SELF.fetch(`${FEDERATION_API}/instances`, {
      headers: authHeaders(moderator.token),
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as Array<Record<string, unknown>>;
    expect(list.find((item) => item.domain === domain)?.suspended).toBe(true);

    const detailResponse = await SELF.fetch(
      `${FEDERATION_API}/instances/${encodeURIComponent(domain)}`,
      { headers: authHeaders(moderator.token) },
    );
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({ domain, suspended: true });
  });

  it('queues refresh and scoped cache reset for a known active instance', async () => {
    const domain = 'queue-actions.example';
    await insertInstance(domain);

    const refreshResponse = await actionRequest(admin, domain, '/refresh');
    expect(refreshResponse.status).toBe(202);
    expect(await refreshResponse.json()).toEqual({ domain, queued: true });

    const resetResponse = await actionRequest(admin, domain, '/cache/reset');
    expect(resetResponse.status).toBe(202);
    expect(await resetResponse.json()).toEqual({ domain, queued: true });
  });

  it('rejects queued work for unknown instances and refreshes for suspended instances', async () => {
    const unknownResponse = await actionRequest(admin, 'unknown-instance.example', '/cache/reset');
    expect(unknownResponse.status).toBe(404);

    const suspendedDomain = 'suspended-refresh.example';
    await insertInstance(suspendedDomain);
    await insertDomainBlock(suspendedDomain, 'suspend');
    const refreshResponse = await actionRequest(admin, suspendedDomain, '/refresh');
    expect(refreshResponse.status).toBe(409);
  });

  it('requires a full admin for every mutating or diagnostic instance action', async () => {
    const domain = 'admin-only-actions.example';
    await insertInstance(domain);

    const requests: Array<{ suffix: string; method?: string; body?: string }> = [
      { suffix: '/refresh' },
      { suffix: '/diagnose' },
      { suffix: '/cache/reset' },
      { suffix: '/suspension', body: JSON.stringify({ suspended: true }) },
      { suffix: '', method: 'DELETE' },
    ];

    for (const request of requests) {
      const response = await actionRequest(
        moderator,
        domain,
        request.suffix,
        request.method ?? 'POST',
        request.body,
      );
      expect(response.status, `${request.method ?? 'POST'} ${request.suffix}`).toBe(403);
    }
  });

  it('temporarily promotes an existing policy and restores all of its fields on resume', async () => {
    const domain = 'temporary-suspension.example';
    await insertInstance(domain);
    const blockId = await insertDomainBlock(domain, 'silence', {
      rejectMedia: true,
      rejectReports: true,
      privateComment: 'keep private',
      publicComment: 'keep public',
      obfuscate: true,
    });
    await env.CACHE.put(`domblk:${domain}`, JSON.stringify({ severity: 'silence' }));

    const suspendResponse = await suspensionRequest(admin, domain, true);
    expect(suspendResponse.status).toBe(200);
    expect(await suspendResponse.json()).toEqual({ domain, suspended: true });
    expect(await env.CACHE.get(`domblk:${domain}`)).toBeNull();

    const suspendedBlock = await readDomainBlock(domain);
    expect(suspendedBlock).toMatchObject({
      id: blockId,
      severity: 'suspend',
      reject_media: 1,
      reject_reports: 1,
      private_comment: 'keep private',
      public_comment: 'keep public',
      obfuscate: 1,
    });
    const tracked = await env.DB.prepare(
      'SELECT domain_block_id, previous_severity FROM federation_suspensions WHERE domain = ?1',
    ).bind(domain).first<Record<string, unknown>>();
    expect(tracked).toEqual({ domain_block_id: blockId, previous_severity: 'silence' });

    const resumeResponse = await suspensionRequest(admin, domain, false);
    expect(resumeResponse.status).toBe(200);
    expect(await resumeResponse.json()).toEqual({ domain, suspended: false });
    expect(await readDomainBlock(domain)).toMatchObject({
      id: blockId,
      severity: 'silence',
      reject_media: 1,
      reject_reports: 1,
      private_comment: 'keep private',
      public_comment: 'keep public',
      obfuscate: 1,
    });
    expect(await env.DB.prepare(
      'SELECT domain FROM federation_suspensions WHERE domain = ?1',
    ).bind(domain).first()).toBeNull();
  });

  it('removes only a temporary block, while an existing untracked suspension becomes noop', async () => {
    const temporaryDomain = 'new-temporary-block.example';
    await insertInstance(temporaryDomain);
    expect((await suspensionRequest(admin, temporaryDomain, true)).status).toBe(200);
    expect((await readDomainBlock(temporaryDomain))?.severity).toBe('suspend');
    expect((await suspensionRequest(admin, temporaryDomain, false)).status).toBe(200);
    expect(await readDomainBlock(temporaryDomain)).toBeNull();

    const existingDomain = 'existing-manual-suspension.example';
    await insertInstance(existingDomain);
    const blockId = await insertDomainBlock(existingDomain, 'suspend', {
      rejectMedia: true,
      publicComment: 'manual policy',
    });
    expect((await suspensionRequest(admin, existingDomain, false)).status).toBe(200);
    expect(await readDomainBlock(existingDomain)).toMatchObject({
      id: blockId,
      severity: 'noop',
      reject_media: 1,
      public_comment: 'manual policy',
    });
  });

  it('preserves domain-block edits made while a temporary suspension is active', async () => {
    const domain = 'edited-temporary-suspension.example';
    await insertInstance(domain);
    expect((await suspensionRequest(admin, domain, true)).status).toBe(200);
    const block = await readDomainBlock(domain);

    const editResponse = await SELF.fetch(
      `${BASE}/api/v1/admin/domain_blocks/${encodeURIComponent(block!.id as string)}`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          severity: 'suspend',
          reject_media: true,
          private_comment: 'keep the manual edit',
        }),
      },
    );
    expect(editResponse.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT domain FROM federation_suspensions WHERE domain = ?1',
    ).bind(domain).first()).toBeNull();

    expect((await suspensionRequest(admin, domain, false)).status).toBe(200);
    expect(await readDomainBlock(domain)).toMatchObject({
      id: block!.id,
      severity: 'noop',
      reject_media: 1,
      private_comment: 'keep the manual edit',
    });
  });

  it('keeps concurrent duplicate suspension requests idempotent', async () => {
    const domain = 'concurrent-suspension.example';
    await insertInstance(domain);

    const suspendResponses = await Promise.all([
      suspensionRequest(admin, domain, true),
      suspensionRequest(admin, domain, true),
    ]);
    expect(suspendResponses.map((response) => response.status)).toEqual([200, 200]);
    expect((await readDomainBlock(domain))?.severity).toBe('suspend');
    expect((await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM federation_suspensions WHERE domain = ?1',
    ).bind(domain).first<{ count: number }>())?.count).toBe(1);

    const resumeResponses = await Promise.all([
      suspensionRequest(admin, domain, false),
      suspensionRequest(admin, domain, false),
    ]);
    expect(resumeResponses.map((response) => response.status)).toEqual([200, 200]);
    expect(await readDomainBlock(domain)).toBeNull();
  });

  it('validates the suspension body', async () => {
    const domain = 'invalid-suspension-body.example';
    await insertInstance(domain);

    const response = await actionRequest(
      admin,
      domain,
      '/suspension',
      'POST',
      JSON.stringify({ suspended: 'yes' }),
    );
    expect(response.status).toBe(400);
  });

  it('deletes only the instance summary and preserves actors and policy', async () => {
    const domain = 'delete-summary-only.example';
    await insertInstance(domain);
    const accountId = await insertRemoteAccount(domain);
    const blockId = await insertDomainBlock(domain, 'silence');

    const response = await actionRequest(admin, domain, '', 'DELETE');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ domain, deleted: true });
    expect(await env.DB.prepare('SELECT id FROM instances WHERE domain = ?1')
      .bind(domain).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1')
      .bind(accountId).first()).toEqual({ id: accountId });
    expect(await env.DB.prepare('SELECT id FROM domain_blocks WHERE id = ?1')
      .bind(blockId).first()).toEqual({ id: blockId });
  });

  it('returns bounded diagnostic output, uses HEAD for delivery, and never exposes key material', async () => {
    const domain = 'diagnostics.example';
    const inboxDomain = 'shared-diagnostics.example';
    const secretPem = '-----BEGIN PUBLIC KEY-----\nTOP_SECRET_KEY_MATERIAL\n-----END PUBLIC KEY-----';
    await insertInstance(domain);
    await insertRemoteAccount(domain, {
      inboxUrl: `https://${inboxDomain}/inbox?secret=hidden`,
      publicKeyPem: secretPem,
    });

    const outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      if (request.method === 'HEAD') return new Response(null, { status: 405 });
      throw new Error(`raw response payload\n${secretPem}\nstack: remote details`);
    });
    vi.stubGlobal('fetch', outbound);

    const response = await actionRequest(admin, domain, '/diagnose');
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(['checked_at', 'checks', 'domain', 'healthy']);
    expect(body.domain).toBe(domain);
    expect(Number.isNaN(Date.parse(body.checked_at))).toBe(false);
    expect(typeof body.healthy).toBe('boolean');
    expect(Object.keys(body.checks).sort()).toEqual(['actor', 'delivery', 'nodeinfo']);
    for (const check of Object.values(body.checks) as Array<Record<string, unknown>>) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'error', 'ok']);
      expect(typeof check.ok).toBe('boolean');
      expect(check.detail === null || typeof check.detail === 'string').toBe(true);
      expect(check.error === null || typeof check.error === 'string').toBe(true);
    }
    expect(body.checks.delivery).toEqual({
      ok: true,
      detail: `HEAD 405 https://${inboxDomain}/inbox`,
      error: null,
    });

    const requests = outbound.mock.calls.map(([input, init]) => toRequest(input, init));
    expect(requests.some(
      (request) => request.method === 'HEAD' && request.url === `https://${inboxDomain}/inbox?secret=hidden`,
    )).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('TOP_SECRET_KEY_MATERIAL');
    expect(serialized.toLowerCase()).not.toContain('stack');
    expect(serialized).not.toContain('raw response payload');
    expect(serialized).not.toContain('secret=hidden');
  });

  it('does not send diagnostic probes to private, local, or rebinding hostnames', async () => {
    const domains = ['127.0.0.1', 'localhost', 'localtest.me'];
    const outbound = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', outbound);

    for (const domain of domains) {
      await insertInstance(domain);
      await insertRemoteAccount(domain, { inboxUrl: `https://${domain}/inbox` });
      const response = await actionRequest(admin, domain, '/diagnose');
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.checks.delivery).toEqual({
        ok: false,
        detail: `https://${domain}/inbox`,
        error: 'Remote inbox is not a safe HTTPS target',
      });
    }

    expect(outbound).not.toHaveBeenCalled();
  });
});

async function actionRequest(
  user: TestUser,
  domain: string,
  suffix: string,
  method = 'POST',
  body?: string,
): Promise<Response> {
  return SELF.fetch(
    `${FEDERATION_API}/instances/${encodeURIComponent(domain)}${suffix}`,
    {
      method,
      headers: authHeaders(user.token),
      body,
    },
  );
}

async function suspensionRequest(
  user: TestUser,
  domain: string,
  suspended: boolean,
): Promise<Response> {
  return actionRequest(
    user,
    domain,
    '/suspension',
    'POST',
    JSON.stringify({ suspended }),
  );
}

async function insertInstance(domain: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO instances (id, domain, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)`,
  ).bind(id, domain, now).run();
  return id;
}

async function insertRemoteAccount(
  domain: string,
  options: { inboxUrl?: string; publicKeyPem?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const username = `remote_${id.replaceAll('-', '')}`;
  const now = new Date().toISOString();
  const uri = `https://${domain}/users/${username}`;
  await env.DB.prepare(
    `INSERT INTO accounts (
       id, username, domain, display_name, note, uri, url,
       inbox_url, public_key_pem, public_key_id, fetched_at, created_at, updated_at
     ) VALUES (?1, ?2, ?3, '', '', ?4, ?4, ?5, ?6, ?7, ?8, ?8, ?8)`,
  ).bind(
    id,
    username,
    domain,
    uri,
    options.inboxUrl ?? `https://${domain}/inbox`,
    options.publicKeyPem ?? 'stored public key',
    `${uri}#main-key`,
    now,
  ).run();
  return id;
}

async function insertDomainBlock(
  domain: string,
  severity: 'noop' | 'silence' | 'suspend',
  options: {
    rejectMedia?: boolean;
    rejectReports?: boolean;
    privateComment?: string;
    publicComment?: string;
    obfuscate?: boolean;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO domain_blocks (
       id, domain, severity, reject_media, reject_reports,
       private_comment, public_comment, obfuscate, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(
    id,
    domain,
    severity,
    options.rejectMedia ? 1 : 0,
    options.rejectReports ? 1 : 0,
    options.privateComment ?? null,
    options.publicComment ?? null,
    options.obfuscate ? 1 : 0,
    now,
  ).run();
  return id;
}

async function readDomainBlock(domain: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT id, severity, reject_media, reject_reports,
            private_comment, public_comment, obfuscate
     FROM domain_blocks WHERE domain = ?1`,
  ).bind(domain).first<Record<string, unknown>>();
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}
