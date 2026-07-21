import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  DEBUG_LOG_MAX_BODY_LENGTH,
  debugLog,
  isDebugEnabled,
  parseBodyForDebugLog,
  readLimitedBody,
  redactUltraSensitive,
  setDebugLogSink,
  truncateForDebugLog,
} from '../../../packages/shared/utils/debugLog';

// The vitest config aliases `cloudflare:workers` to a mutable mock object.
const mockEnv = env as Record<string, unknown>;

const PEM_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB',
  '-----END PRIVATE KEY-----',
].join('\n');

afterEach(() => {
  delete mockEnv.DEBUG;
  vi.restoreAllMocks();
});

describe('isDebugEnabled', () => {
  it('is disabled when DEBUG is missing', () => {
    expect(isDebugEnabled()).toBe(false);
  });

  it('is disabled for false-ish values', () => {
    for (const value of [false, 'false', '0', '', null, 'yes']) {
      mockEnv.DEBUG = value;
      expect(isDebugEnabled()).toBe(false);
    }
  });

  it('is enabled for true, "true", and "1"', () => {
    for (const value of [true, 'true', '1']) {
      mockEnv.DEBUG = value;
      expect(isDebugEnabled()).toBe(true);
    }
  });
});

describe('debugLog', () => {
  it('logs nothing when DEBUG is off', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('http', 'request', { path: '/api/v1/apps' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs scope, message, and serialized details when DEBUG is on', () => {
    mockEnv.DEBUG = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('federation.inbox', 'Follow received', { actor: 'https://remote.example/u/a' });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain('[debug][federation.inbox] Follow received');
    expect(line).toContain('https://remote.example/u/a');
  });

  it('redacts ultra-sensitive fields but keeps content and public keys', () => {
    mockEnv.DEBUG = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('http', 'login', {
      body: { username: 'alice', password: 'hunter2' },
      headers: { authorization: 'Bearer abc123', cookie: 'sid=1', accept: 'application/json' },
      actor: {
        private_key: PEM_KEY,
        ed25519_private_key: 'raw-ed25519-material',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----',
      },
      activity: { content: '<p>hello fediverse</p>', signature: 'sig-value' },
    });
    const line = spy.mock.calls[0][0] as string;
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Bearer abc123');
    expect(line).not.toContain('sid=1');
    expect(line).not.toContain('BEGIN PRIVATE KEY');
    expect(line).not.toContain('raw-ed25519-material');
    expect(line).toContain('alice');
    expect(line).toContain('application/json');
    expect(line).toContain('BEGIN PUBLIC KEY');
    expect(line).toContain('hello fediverse');
    expect(line).toContain('sig-value');
  });
});

describe('debug log sink', () => {
  afterEach(() => {
    setDebugLogSink(null);
  });

  it('mirrors redacted output to a registered sink only when DEBUG is on', () => {
    const events: Array<{ scope: string; message: string; details?: unknown }> = [];
    setDebugLogSink((scope, message, details) => {
      events.push({ scope, message, details });
    });

    debugLog('http', 'while off', { password: 'x' });
    expect(events).toHaveLength(0);

    mockEnv.DEBUG = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('http', 'while on', { password: 'x', user: 'alice' });
    expect(events).toHaveLength(1);
    expect(events[0].scope).toBe('http');
    expect(events[0].message).toBe('while on');
    const details = events[0].details as Record<string, unknown>;
    expect(details.password).toBe('[REDACTED]');
    expect(details.user).toBe('alice');
  });

  it('keeps logging to the console when the sink throws', () => {
    mockEnv.DEBUG = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebugLogSink(() => {
      throw new Error('sink down');
    });
    expect(() => debugLog('http', 'still logs', { a: 1 })).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('redactUltraSensitive', () => {
  it('redacts private JWK members but keeps public ones', () => {
    const redacted = redactUltraSensitive({
      kty: 'RSA',
      n: 'public-modulus',
      e: 'AQAB',
      d: 'private-exponent',
      p: 'prime1',
    }) as Record<string, unknown>;
    expect(redacted.kty).toBe('RSA');
    expect(redacted.n).toBe('public-modulus');
    expect(redacted.d).toBe('[REDACTED]');
    expect(redacted.p).toBe('[REDACTED]');
  });

  it('redacts Fedify queued-message sender keys wholesale', () => {
    const redacted = redactUltraSensitive({
      type: 'outbox',
      keys: [{ keyId: 'https://me.example/u/a#main-key', privateKey: { kty: 'RSA', d: 'x' } }],
      activity: { type: 'Create', id: 'https://me.example/a/1' },
    }) as { keys: Array<Record<string, unknown>>; activity: Record<string, unknown> };
    expect(redacted.keys[0].privateKey).toBe('[REDACTED]');
    expect(redacted.keys[0].keyId).toBe('https://me.example/u/a#main-key');
    expect(redacted.activity.id).toBe('https://me.example/a/1');
  });

  it('scrubs PEM private key blocks inside arbitrary strings', () => {
    const redacted = redactUltraSensitive({ note: `before\n${PEM_KEY}\nafter` }) as Record<string, string>;
    expect(redacted.note).not.toContain('BEGIN PRIVATE KEY');
    expect(redacted.note).toContain('before');
    expect(redacted.note).toContain('after');
  });

  it('survives circular structures', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    const redacted = redactUltraSensitive(value) as Record<string, unknown>;
    expect(redacted.name).toBe('loop');
    expect(redacted.self).toBe('[Circular]');
  });

  it('redacts sensitive query parameters inside URL strings', () => {
    const redacted = redactUltraSensitive({
      url: 'https://social.example.com/auth/confirm?token=secret-token&next=%2Fhome',
      location: 'https://app.example/cb?code=oauth-code&state=xyz',
      plainPath: '/auth/confirm?token=not-a-full-url',
    }) as Record<string, string>;
    expect(redacted.url).not.toContain('secret-token');
    expect(redacted.url).toContain('token=REDACTED');
    expect(redacted.url).toContain('next=');
    expect(redacted.location).not.toContain('oauth-code');
    expect(redacted.location).toContain('state=xyz');
    // Non-URL strings pass through untouched (field-name rules cover them).
    expect(redacted.plainPath).toBe('/auth/confirm?token=not-a-full-url');
  });

  it('redacts one-time credentials in innocuously named fields', () => {
    const redacted = redactUltraSensitive({
      code: '123456',
      otp_code: '654321',
      code_verifier: 'pkce-verifier',
      backup_codes: ['aaa', 'bbb'],
      subscription: { keys: { auth: 'push-auth-secret', p256dh: 'public-key' } },
    }) as Record<string, unknown> & { subscription: { keys: Record<string, string> } };
    expect(redacted.code).toBe('[REDACTED]');
    expect(redacted.otp_code).toBe('[REDACTED]');
    expect(redacted.code_verifier).toBe('[REDACTED]');
    expect(redacted.backup_codes).toBe('[REDACTED]');
    expect(redacted.subscription.keys.auth).toBe('[REDACTED]');
    expect(redacted.subscription.keys.p256dh).toBe('public-key');
  });

  it('does not over-match code-like or auth-like field names', () => {
    const redacted = redactUltraSensitive({
      shortcode: 'blobcat',
      statusCode: 404,
      authorized_fetch: true,
    }) as Record<string, unknown>;
    expect(redacted.shortcode).toBe('blobcat');
    expect(redacted.statusCode).toBe(404);
    expect(redacted.authorized_fetch).toBe(true);
  });

  it('preserves Map and Set contents instead of logging {}', () => {
    const redacted = redactUltraSensitive({
      map: new Map<string, string>([['password', 'x'], ['actor', 'https://a.example']]),
      set: new Set(['one', 'two']),
    }) as { map: Record<string, string>; set: string[] };
    expect(redacted.map.password).toBe('[REDACTED]');
    expect(redacted.map.actor).toBe('https://a.example');
    expect(redacted.set).toEqual(['one', 'two']);
  });

  it('flattens Headers instances and redacts sensitive entries', () => {
    const redacted = redactUltraSensitive(
      new Headers({ Authorization: 'Bearer secret', 'X-Request-Id': 'rid' }),
    ) as Record<string, string>;
    // Header name casing differs between runtimes; compare case-insensitively.
    const entries = Object.fromEntries(
      Object.entries(redacted).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(entries.authorization).toBe('[REDACTED]');
    expect(entries['x-request-id']).toBe('rid');
  });
});

describe('body helpers', () => {
  it('parses JSON bodies into objects so field redaction applies', () => {
    expect(parseBodyForDebugLog('{"password":"x"}', 'application/json')).toEqual({ password: 'x' });
  });

  it('parses form-urlencoded bodies into objects', () => {
    expect(parseBodyForDebugLog('a=1&password=x', 'application/x-www-form-urlencoded')).toEqual({
      a: '1',
      password: 'x',
    });
  });

  it('truncates oversized text bodies to the hard cap, marker included', () => {
    const text = 'a'.repeat(DEBUG_LOG_MAX_BODY_LENGTH + 10000);
    const truncated = truncateForDebugLog(text);
    expect(truncated.length).toBe(DEBUG_LOG_MAX_BODY_LENGTH);
    expect(truncated).toContain(`[truncated; original ${text.length} chars]`);
  });

  it('reads body streams chunk-by-chunk and cancels at the cap', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('b'.repeat(1024));
    // An endless stream — reading it in full would never terminate.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const text = await readLimitedBody(endless);
    expect(text.length).toBeLessThanOrEqual(DEBUG_LOG_MAX_BODY_LENGTH);
    expect(text).toContain('[truncated; original ');
    expect(cancelled).toBe(true);
    // Stopped shortly after the cap instead of draining the stream.
    expect(pulls).toBeLessThan(DEBUG_LOG_MAX_BODY_LENGTH / 1024 + 8);
  });

  it('returns an empty string for a null body', async () => {
    await expect(readLimitedBody(null)).resolves.toBe('');
  });
});
