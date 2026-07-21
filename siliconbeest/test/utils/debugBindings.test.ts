import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  DEBUG_LOG_MAX_ROWS,
  instrumentD1ForDebug,
  instrumentKVForDebug,
  instrumentQueueForDebug,
  instrumentR2ForDebug,
} from '../../../packages/shared/utils/debugBindings';

// The vitest config aliases `cloudflare:workers` to a mutable mock object.
const mockEnv = env as Record<string, unknown>;

afterEach(() => {
  delete mockEnv.DEBUG;
  vi.restoreAllMocks();
});

function spyLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function loggedLines(spy: ReturnType<typeof spyLog>): string[] {
  return spy.mock.calls.map((call) => call[0] as string);
}

// ----------------------------------------------------------------
// D1
// ----------------------------------------------------------------

type FakeStatement = {
  bind: (...values: unknown[]) => FakeStatement;
  first: (column?: string) => Promise<unknown>;
  run: () => Promise<unknown>;
  all: () => Promise<unknown>;
  raw: (options?: unknown) => Promise<unknown>;
};

function makeFakeDb(rows: Array<Record<string, unknown>>) {
  const statement: FakeStatement = {
    bind: () => statement,
    first: async () => rows[0] ?? null,
    all: async () => ({ success: true, meta: { rows_read: rows.length }, results: rows }),
    run: async () => ({ success: true, meta: { changes: 1 }, results: [] }),
    raw: async () => rows.map((row) => Object.values(row)),
  };
  const batchCalls: unknown[][] = [];
  const db = {
    prepare: (_sql: string) => statement,
    batch: async (statements: unknown[]) => {
      batchCalls.push(statements);
      return statements.map(() => ({ success: true, meta: {}, results: [] }));
    },
    exec: async (_sql: string) => ({ count: 1, duration: 0 }),
  };
  return { db, statement, batchCalls };
}

type InstrumentedDb = {
  prepare: (sql: string) => FakeStatement;
  batch: (statements: unknown[]) => Promise<unknown>;
  exec: (sql: string) => Promise<unknown>;
};

describe('instrumentD1ForDebug', () => {
  it('logs sql, params, duration, and the row for first()', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const { db } = makeFakeDb([{ id: '01ABC', username: 'alice' }]);
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    const row = await instrumentedDb
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .bind('alice')
      .first();

    expect(row).toEqual({ id: '01ABC', username: 'alice' });
    expect(spy).toHaveBeenCalledOnce();
    const line = loggedLines(spy)[0];
    expect(line).toContain('[debug][d1] DB.first SELECT * FROM accounts WHERE username = ?');
    expect(line).toContain('"alice"');
    expect(line).toContain('01ABC');
    expect(line).toContain('durationMs');
  });

  it('logs result metadata and rows for all(), capping oversized result sets', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const rows = Array.from({ length: DEBUG_LOG_MAX_ROWS + 10 }, (_, i) => ({ id: `id-${i}` }));
    const { db } = makeFakeDb(rows);
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    const result = (await instrumentedDb.prepare('SELECT id FROM statuses').all()) as {
      results: unknown[];
    };

    // The caller still receives the full, unmodified result.
    expect(result.results).toHaveLength(DEBUG_LOG_MAX_ROWS + 10);
    const line = loggedLines(spy)[0];
    expect(line).toContain(`"rowCount":${DEBUG_LOG_MAX_ROWS + 10}`);
    expect(line).toContain('"rowsTruncated":true');
    expect(line).toContain('id-0');
    expect(line).not.toContain(`id-${DEBUG_LOG_MAX_ROWS + 9}`);
  });

  it('withholds bind params for statements referencing sensitive columns', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const { db } = makeFakeDb([]);
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    await instrumentedDb
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .bind('raw-token-material')
      .first();

    const line = loggedLines(spy)[0];
    expect(line).not.toContain('raw-token-material');
    expect(line).toContain('withheld');
  });

  it('unwraps instrumented statements before handing them to batch()', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const { db, statement, batchCalls } = makeFakeDb([]);
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    const wrapped = instrumentedDb.prepare('UPDATE accounts SET note = ? WHERE id = ?').bind('hi', '01ABC');
    await instrumentedDb.batch([wrapped]);

    // The real (unwrapped) statement reached the underlying driver.
    expect(batchCalls[0][0]).toBe(statement);
    const line = loggedLines(spy)[0];
    expect(line).toContain('[debug][d1] DB.batch (1 statements)');
    expect(line).toContain('UPDATE accounts SET note = ?');
    expect(line).toContain('"hi"');
  });

  it('does not double-instrument the same binding', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const { db } = makeFakeDb([{ id: '1' }]);
    instrumentD1ForDebug(db, 'DB');
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    await instrumentedDb.prepare('SELECT 1').first();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('logs and re-throws query errors', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const db = {
      prepare: (_sql: string) => ({
        bind: function bind() { return this; },
        first: async () => { throw new Error('D1_ERROR: no such table'); },
      }),
    };
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    await expect(instrumentedDb.prepare('SELECT * FROM missing').first()).rejects.toThrow('no such table');
    const line = loggedLines(spy)[0];
    expect(line).toContain('DB.first SELECT * FROM missing threw');
    expect(line).toContain('no such table');
  });
});

// ----------------------------------------------------------------
// KV
// ----------------------------------------------------------------

describe('instrumentKVForDebug', () => {
  function makeFakeKv(storedValue: unknown) {
    return {
      get: async (_key: string, _options?: unknown) => storedValue,
      put: async (_key: string, _value: unknown, _options?: unknown) => undefined,
      delete: async (_key: string) => undefined,
      list: async (_options?: unknown) => ({
        keys: [{ name: 'instance:stats' }],
        list_complete: true,
      }),
    };
  }
  type InstrumentedKv = ReturnType<typeof makeFakeKv>;

  it('logs key, options, and the parsed value for get()', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const kv = makeFakeKv('{"statuses":12}');
    instrumentKVForDebug(kv, 'CACHE');

    await expect((kv as InstrumentedKv).get('instance:stats', 'json')).resolves.toBe('{"statuses":12}');
    const line = loggedLines(spy)[0];
    expect(line).toContain('[debug][kv] CACHE.get instance:stats');
    expect(line).toContain('"statuses":12');
    expect(line).toContain('durationMs');
  });

  it('redacts credential-bearing key suffixes in message and details', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const kv = makeFakeKv(null);
    instrumentKVForDebug(kv, 'SESSIONS');

    await (kv as InstrumentedKv).get('oauth_session:raw-session-token');
    await (kv as InstrumentedKv).delete('token:raw-token-hash');

    const lines = loggedLines(spy);
    expect(lines[0]).toContain('oauth_session:[REDACTED]');
    expect(lines[0]).not.toContain('raw-session-token');
    expect(lines[1]).toContain('token:[REDACTED]');
    expect(lines[1]).not.toContain('raw-token-hash');
  });

  it('logs values and options for put(), redacting sensitive fields inside JSON', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const kv = makeFakeKv(null);
    instrumentKVForDebug(kv, 'CACHE');

    await (kv as InstrumentedKv).put(
      'instance:stats',
      JSON.stringify({ statuses: 12, secret_value: 'hidden' }),
      { expirationTtl: 300 },
    );

    const line = loggedLines(spy)[0];
    expect(line).toContain('CACHE.put instance:stats');
    expect(line).toContain('"statuses":12');
    expect(line).not.toContain('hidden');
    expect(line).toContain('"expirationTtl":300');
  });

  it('logs list() results with key names', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const kv = makeFakeKv(null);
    instrumentKVForDebug(kv, 'CACHE');

    await (kv as InstrumentedKv).list({ prefix: 'instance:' });
    const line = loggedLines(spy)[0];
    expect(line).toContain('CACHE.list');
    expect(line).toContain('instance:stats');
    expect(line).toContain('"keyCount":1');
  });
});

// ----------------------------------------------------------------
// R2 and Queues
// ----------------------------------------------------------------

describe('instrumentR2ForDebug', () => {
  it('logs object metadata, never the body', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const bucket = {
      get: async (_key: string) => ({
        key: 'media/avatar.png',
        size: 2048,
        etag: 'etag-1',
        body: '<actual bytes that must not be logged>',
      }),
    };
    instrumentR2ForDebug(bucket, 'MEDIA_BUCKET');

    await (bucket as { get: (key: string) => Promise<unknown> }).get('media/avatar.png');
    const line = loggedLines(spy)[0];
    expect(line).toContain('[debug][r2] MEDIA_BUCKET.get media/avatar.png');
    expect(line).toContain('"size":2048');
    expect(line).not.toContain('actual bytes');
  });
});

describe('instrumentQueueForDebug', () => {
  it('logs the message body for send()', async () => {
    mockEnv.DEBUG = true;
    const spy = spyLog();
    const sent: unknown[] = [];
    const queue = {
      send: async (message: unknown, _options?: unknown) => {
        sent.push(message);
      },
    };
    instrumentQueueForDebug(queue, 'QUEUE_FEDERATION');

    await (queue as { send: (message: unknown) => Promise<void> }).send({
      type: 'deliver_activity',
      activityId: 'https://me.example/a/1',
    });

    expect(sent).toHaveLength(1);
    const line = loggedLines(spy)[0];
    expect(line).toContain('[debug][queue.send] QUEUE_FEDERATION.send');
    expect(line).toContain('deliver_activity');
    expect(line).toContain('https://me.example/a/1');
  });
});

describe('instrumentation while DEBUG is off', () => {
  it('passes results through without logging', async () => {
    const spy = spyLog();
    const { db } = makeFakeDb([{ id: '1' }]);
    instrumentD1ForDebug(db, 'DB');
    const instrumentedDb = db as unknown as InstrumentedDb;

    await expect(instrumentedDb.prepare('SELECT 1').first()).resolves.toEqual({ id: '1' });
    expect(spy).not.toHaveBeenCalled();
  });
});
