import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { encodeTime } from 'ulid';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const CACHE_KEY = 'airport:stats:v4';

const HOUR = 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/** Build a ULID whose time component is `msAgo` in the past. */
function ulidAt(msAgo: number, suffix = '0000000000000001'): string {
  return encodeTime(Date.now() - msAgo, 10) + suffix;
}

async function insertRemoteAccount(id: string, domain: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, 'user-' + id, domain, `https://${domain}/users/${id}`, now, now)
    .run();
}

async function insertStatus(opts: {
  id: string;
  accountId: string;
  local: number;
  createdAt: string;
  reblogOfId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO statuses (id, uri, account_id, local, reblog_of_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      `https://test.siliconbeest.local/statuses/${opts.id}`,
      opts.accountId,
      opts.local,
      opts.reblogOfId ?? null,
      opts.createdAt,
      opts.createdAt,
    )
    .run();
}

async function insertMedia(opts: {
  id: string;
  accountId: string;
  fileSize: number;
  remoteUrl?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO media_attachments (id, account_id, file_key, file_content_type, file_size, remote_url, created_at, updated_at)
     VALUES (?, ?, ?, 'image/png', ?, ?, ?, ?)`,
  )
    .bind(opts.id, opts.accountId, `media/${opts.id}.png`, opts.fileSize, opts.remoteUrl ?? null, now, now)
    .run();
}

async function insertInstance(opts: {
  domain: string;
  lastSuccessfulAt?: string | null;
  lastFailedAt?: string | null;
  failureCount?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO instances (id, domain, last_successful_at, last_failed_at, failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.domain,
      opts.lastSuccessfulAt ?? null,
      opts.lastFailedAt ?? null,
      opts.failureCount ?? 0,
      now,
      now,
    )
    .run();
}

describe('GET /api/airport', () => {
  let localAccountId: string;

  beforeAll(async () => {
    await applyMigration();
    const user = await createTestUser('airport_local');
    localAccountId = user.accountId;

    // Remote accounts on two domains, one of which will be suspended.
    await insertRemoteAccount('remote-a', 'friendly.example');
    await insertRemoteAccount('remote-b', 'blocked.example');

    // Local statuses: one recent (counted), one 48h old (outside window).
    await insertStatus({
      id: ulidAt(1 * HOUR, '0000000000000001'),
      accountId: localAccountId,
      local: 1,
      createdAt: iso(1 * HOUR),
    });
    await insertStatus({
      id: ulidAt(48 * HOUR, '0000000000000002'),
      accountId: localAccountId,
      local: 1,
      createdAt: iso(48 * HOUR),
    });

    // Remote statuses: two from friendly.example, one from blocked.example.
    const remoteRecent = ulidAt(2 * HOUR, '0000000000000003');
    await insertStatus({
      id: remoteRecent,
      accountId: 'remote-a',
      local: 0,
      createdAt: iso(2 * HOUR),
    });
    await insertStatus({
      id: ulidAt(3 * HOUR, '0000000000000004'),
      accountId: 'remote-a',
      local: 0,
      createdAt: iso(3 * HOUR),
    });
    await insertStatus({
      id: ulidAt(4 * HOUR, '0000000000000005'),
      accountId: 'remote-b',
      local: 0,
      createdAt: iso(4 * HOUR),
    });

    // Local reblog of a remote status (a "transfer").
    await insertStatus({
      id: ulidAt(1 * HOUR, '0000000000000006'),
      accountId: localAccountId,
      local: 1,
      createdAt: iso(1 * HOUR),
      reblogOfId: remoteRecent,
    });

    // Media: recent local upload (counted, 1000 bytes), old local upload
    // (outside window via ULID time prefix), recent remote media.
    await insertMedia({
      id: ulidAt(1 * HOUR, '0000000000000007'),
      accountId: localAccountId,
      fileSize: 1000,
    });
    await insertMedia({
      id: ulidAt(48 * HOUR, '0000000000000008'),
      accountId: localAccountId,
      fileSize: 5000,
    });
    await insertMedia({
      id: ulidAt(2 * HOUR, '0000000000000009'),
      accountId: 'remote-a',
      fileSize: 0, // remote attachments are never stored locally — no file_size
      remoteUrl: 'https://friendly.example/media/1.png',
    });

    // The media-proxy ledger knows this attachment's real size because the
    // proxy measured it while fetching from origin.
    await env.DB.prepare(
      `INSERT INTO media_proxy_cache (id, remote_url, r2_key, content_type, size, created_at)
       VALUES (?, 'https://friendly.example/media/1.png', '', 'image/png', 3500, ?)`,
    )
      .bind(crypto.randomUUID(), new Date().toISOString())
      .run();

    // Delivery routes: one healthy, one failing.
    await insertInstance({
      domain: 'friendly.example',
      lastSuccessfulAt: iso(1 * HOUR),
    });
    await insertInstance({
      domain: 'unreachable.example',
      lastSuccessfulAt: iso(20 * HOUR),
      lastFailedAt: iso(1 * HOUR),
      failureCount: 3,
    });

    // Suspend blocked.example — it must not appear anywhere in the response.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
       VALUES (?, 'blocked.example', 'suspend', ?, ?)`,
    )
      .bind(crypto.randomUUID(), now, now)
      .run();

    // DLQ backlog: two parked deliveries plus one already replayed —
    // only status='parked' rows may be counted.
    for (const status of ['parked', 'parked', 'replayed']) {
      await env.DB.prepare(
        `INSERT INTO federation_dlq_parked (id, queue, body, error, attempts, status, parked_at, updated_at)
         VALUES (?, 'siliconbeest-federation-dlq', '{}', 'connection refused', 6, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), status, now, now)
        .run();
    }
  });

  beforeEach(async () => {
    // Each test asserts against fresh DB-derived numbers unless it is
    // explicitly testing the cache path.
    await env.CACHE.delete(CACHE_KEY);
  });

  it('returns 200 without auth and sets Cache-Control', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=30');
  });

  it('has the documented aggregate shape', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    expect(body.window).toBe('24h');
    expect(typeof body.generatedAt).toBe('string');
    expect(typeof body.flights.departures).toBe('number');
    expect(typeof body.flights.arrivals).toBe('number');
    expect(typeof body.flights.transfers).toBe('number');
    expect(typeof body.cargo.outCount).toBe('number');
    expect(typeof body.cargo.outBytes).toBe('number');
    expect(typeof body.cargo.inCount).toBe('number');
    expect(typeof body.cargo.inBytes).toBe('number');
    expect(typeof body.passport.registrations).toBe('number');
    expect(typeof body.dlq.parked).toBe('number');
    expect(Array.isArray(body.destinations)).toBe(true);
    expect(Array.isArray(body.delayedRoutes)).toBe(true);
  });

  it('counts only the last 24 hours', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    // 1 plain local status + 1 local reblog = 2 departures; the 48h-old one is excluded.
    expect(body.flights.departures).toBe(2);
    expect(body.flights.arrivals).toBe(3);
    expect(body.flights.transfers).toBe(1);
    expect(body.passport.registrations).toBe(1);
  });

  it('splits cargo by direction and windows media via the ULID primary key', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    // Recent local upload only — the 48h-old 5000-byte one must be excluded.
    expect(body.cargo.outCount).toBe(1);
    expect(body.cargo.outBytes).toBe(1000);
    expect(body.cargo.inCount).toBe(1);
    // in-bytes come from the media-proxy ledger, not file_size
    expect(body.cargo.inBytes).toBe(3500);
  });

  it('lists top origin domains but never suspended ones', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    const domains = body.destinations.map((d: any) => d.domain);
    expect(domains).toContain('friendly.example');
    expect(domains).not.toContain('blocked.example');
    const friendly = body.destinations.find((d: any) => d.domain === 'friendly.example');
    expect(friendly.arrivals).toBe(2);
    expect(friendly.delayed).toBe(false);
  });

  it('counts only parked DLQ entries, not replayed ones', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    expect(body.dlq.parked).toBe(2);
  });

  it('reports failing delivery routes as delayed', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    const delayed = body.delayedRoutes.find((r: any) => r.domain === 'unreachable.example');
    expect(delayed).toBeDefined();
    expect(delayed.failureCount).toBe(3);
    expect(delayed.lastFailedAt).toBeTruthy();
  });

  it('contains no PII — only aggregates and domains', async () => {
    const res = await SELF.fetch(`${BASE}/api/airport`);
    const text = await res.text();
    expect(text).not.toContain('airport_local'); // username
    expect(text).not.toContain('@test.local'); // email
    expect(text).not.toContain('/users/'); // actor URIs
    expect(text).not.toContain('statuses/'); // status URIs
  });

  it('serves from KV cache without touching the database', async () => {
    // Prime the cache.
    await SELF.fetch(`${BASE}/api/airport`);

    // Add a new status; a cache hit must still return the old numbers.
    await insertStatus({
      id: ulidAt(0, '000000000000000A'),
      accountId: localAccountId,
      local: 1,
      createdAt: iso(0),
    });

    const res = await SELF.fetch(`${BASE}/api/airport`);
    const body = await res.json<any>();
    expect(body.flights.departures).toBe(2); // unchanged → served from cache

    // After the cache is cleared the new status becomes visible.
    await env.CACHE.delete(CACHE_KEY);
    const fresh = await SELF.fetch(`${BASE}/api/airport`);
    const freshBody = await fresh.json<any>();
    expect(freshBody.flights.departures).toBe(3);
  });
});
