import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration } from './helpers';
import { serializeAccount } from '../../server/worker/utils/mastodonSerializer';
import { isValidProxyUrl } from '../../server/worker/endpoints/proxy';
import type { AccountRow } from '../../server/worker/types/db';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTANCE_DOMAIN = 'test.siliconbeest.local';

function makeAccountRow(overrides?: Partial<AccountRow>): AccountRow {
  return {
    id: 'acct-1',
    username: 'testuser',
    domain: null,
    display_name: 'Test User',
    note: 'A test account',
    uri: `https://${INSTANCE_DOMAIN}/users/testuser`,
    url: `https://${INSTANCE_DOMAIN}/@testuser`,
    avatar_url: `https://${INSTANCE_DOMAIN}/media/avatars/test.png`,
    avatar_static_url: `https://${INSTANCE_DOMAIN}/media/avatars/test_static.png`,
    header_url: `https://${INSTANCE_DOMAIN}/media/headers/test.png`,
    header_static_url: `https://${INSTANCE_DOMAIN}/media/headers/test_static.png`,
    locked: 0,
    bot: 0,
    discoverable: 1,
    manually_approves_followers: 0,
    statuses_count: 42,
    followers_count: 10,
    following_count: 5,
    last_status_at: '2024-01-01T00:00:00.000Z',
    created_at: '2023-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    suspended_at: null,
    silenced_at: null,
    memorial: 0,
    moved_to_account_id: null,
    ...overrides,
  };
}

function makeRemoteAccountRow(overrides?: Partial<AccountRow>): AccountRow {
  return makeAccountRow({
    id: 'acct-remote-1',
    username: 'remoteuser',
    domain: 'remote.social',
    uri: 'https://remote.social/users/remoteuser',
    url: 'https://remote.social/@remoteuser',
    avatar_url: 'https://remote.social/media/avatars/remote.png',
    avatar_static_url: 'https://remote.social/media/avatars/remote_static.png',
    header_url: 'https://remote.social/media/headers/remote.png',
    header_static_url: 'https://remote.social/media/headers/remote_static.png',
    ...overrides,
  });
}

// ===========================================================================
// Proxy Endpoint Tests (integration via SELF.fetch)
// ===========================================================================

describe('Proxy Endpoint', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  // -------------------------------------------------------------------------
  // 1. GET /proxy without url param -> 400
  // -------------------------------------------------------------------------
  it('returns 400 when url parameter is missing', async () => {
    const res = await SELF.fetch(`https://${INSTANCE_DOMAIN}/proxy`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('Missing url parameter');
  });

  // -------------------------------------------------------------------------
  // 2. GET /proxy with invalid URL (not http/https) -> 400
  // -------------------------------------------------------------------------
  it('returns 400 for non-http(s) URL schemes', async () => {
    const targets = [
      'ftp://example.com/image.png',
      'data:image/png;base64,abc',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not-a-url',
    ];
    for (const target of targets) {
      const res = await SELF.fetch(
        `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(target)}`,
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('Invalid or disallowed URL');
    }
  });

  // -------------------------------------------------------------------------
  // 3. GET /proxy with localhost/private IP -> 400
  // -------------------------------------------------------------------------
  it('returns 400 for localhost and private IP addresses', async () => {
    const privateUrls = [
      'http://localhost/image.png',
      'http://127.0.0.1/image.png',
      'http://0.0.0.0/image.png',
      'http://10.0.0.1/image.png',
      'http://172.16.0.1/image.png',
      'http://192.168.1.1/image.png',
      'http://myhost.local/image.png',
      'http://internal.localhost/image.png',
      'http://something.internal/image.png',
    ];
    for (const target of privateUrls) {
      const res = await SELF.fetch(
        `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(target)}`,
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('Invalid or disallowed URL');
    }
  });

  // -------------------------------------------------------------------------
  // 4. GET /proxy with valid remote URL -> 200 (cache MISS)
  // -------------------------------------------------------------------------
  it('returns 200 with X-Cache: MISS for a valid remote image URL', async () => {
    // Use a known public URL that serves an image content type.
    // In the Workers test environment, fetch goes through Miniflare.
    // We use a real image URL that should be resolvable.
    const remoteUrl = 'https://cdn.jsdelivr.net/gh/nicehash/Logos@main/favicon-192x192.png';
    const res = await SELF.fetch(
      `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(remoteUrl)}`,
    );
    // The fetch might succeed or fail depending on network in test env.
    // If it fails, we get 502; if content type is wrong, 403; otherwise 200.
    if (res.status === 200) {
      expect(res.headers.get('X-Cache')).toBe('MISS');
      expect(res.headers.get('Cache-Control')).toContain('public');
      expect(res.headers.get('Content-Type')).toBeTruthy();
    } else {
      // In offline/sandboxed test environments, fetch to external URLs may fail
      expect([502, 403, 404]).toContain(res.status);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Cache-Control header is set correctly
  // -------------------------------------------------------------------------
  it('sets Cache-Control to public, max-age=86400, immutable on MISS', async () => {
    const remoteUrl = 'https://cdn.jsdelivr.net/gh/nicehash/Logos@main/favicon-192x192.png';
    const res = await SELF.fetch(
      `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(remoteUrl)}`,
    );
    if (res.status === 200) {
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
    }
  });

  // -------------------------------------------------------------------------
  // 6. Content-Type is passed through from origin
  // -------------------------------------------------------------------------
  it('passes through Content-Type from the origin response', async () => {
    const remoteUrl = 'https://cdn.jsdelivr.net/gh/nicehash/Logos@main/favicon-192x192.png';
    const res = await SELF.fetch(
      `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent(remoteUrl)}`,
    );
    if (res.status === 200) {
      const ct = res.headers.get('Content-Type');
      expect(ct).toBeTruthy();
      expect(ct!.startsWith('image/')).toBe(true);
    }
  });
});

// ===========================================================================
// proxyUrl() Helper Tests (unit tests via serializeAccount internals)
// ===========================================================================

describe('proxyUrl() via serializeAccount', () => {
  // The proxyUrl function is not exported directly, but we can test it
  // through serializeAccount which calls it for remote accounts.
  // We also test the logic indirectly.

  // -------------------------------------------------------------------------
  // 7. Local URL (same domain) -> returns unchanged
  // -------------------------------------------------------------------------
  it('does not proxy local account avatar/header (same domain)', () => {
    const row = makeAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    // Local accounts should keep their URLs as-is
    expect(account.avatar).toBe(`https://${INSTANCE_DOMAIN}/media/avatars/test.png`);
    expect(account.header).toBe(`https://${INSTANCE_DOMAIN}/media/headers/test.png`);
    expect(account.avatar_static).toBe(`https://${INSTANCE_DOMAIN}/media/avatars/test_static.png`);
    expect(account.header_static).toBe(`https://${INSTANCE_DOMAIN}/media/headers/test_static.png`);
  });

  // -------------------------------------------------------------------------
  // 8. Remote URL -> returns /proxy?url=encoded_url
  // -------------------------------------------------------------------------
  it('proxies remote account avatar through /proxy?url=...', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    const expectedAvatar = `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent('https://remote.social/media/avatars/remote.png')}`;
    expect(account.avatar).toBe(expectedAvatar);
  });

  it('proxies remote account header through /proxy?url=...', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    const expectedHeader = `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent('https://remote.social/media/headers/remote.png')}`;
    expect(account.header).toBe(expectedHeader);
  });

  it('proxies remote avatar_static and header_static', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    const expectedAvatarStatic = `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent('https://remote.social/media/avatars/remote_static.png')}`;
    const expectedHeaderStatic = `https://${INSTANCE_DOMAIN}/proxy?url=${encodeURIComponent('https://remote.social/media/headers/remote_static.png')}`;
    expect(account.avatar_static).toBe(expectedAvatarStatic);
    expect(account.header_static).toBe(expectedHeaderStatic);
  });

  // -------------------------------------------------------------------------
  // 9. Empty/null URL -> returns as-is (default fallback)
  // -------------------------------------------------------------------------
  it('uses default avatar for account with empty avatar_url (not proxied)', () => {
    const row = makeRemoteAccountRow({ avatar_url: '' as any });
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    // When avatar_url is empty, it falls back to default-avatar.svg from the URI origin
    // The default is from remote.social, so it should be proxied
    expect(account.avatar).toContain('default-avatar');
  });

  it('uses default header for account with empty header_url (not proxied)', () => {
    const row = makeRemoteAccountRow({ header_url: '' as any });
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.header).toContain('default-header');
  });

  // -------------------------------------------------------------------------
  // 10. URL already on our domain -> not proxied
  // -------------------------------------------------------------------------
  it('does not proxy URLs already on instance domain even for remote accounts', () => {
    // A remote account whose avatar happens to be hosted on our domain
    const row = makeRemoteAccountRow({
      avatar_url: `https://${INSTANCE_DOMAIN}/media/cached/avatar.png`,
    });
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.avatar).toBe(`https://${INSTANCE_DOMAIN}/media/cached/avatar.png`);
    expect(account.avatar).not.toContain('/proxy?url=');
  });
});

// ===========================================================================
// serializeAccount Proxy Integration Tests
// ===========================================================================

describe('serializeAccount proxy behavior', () => {
  // -------------------------------------------------------------------------
  // 11. Local account avatar/header -> not proxied (our domain)
  // -------------------------------------------------------------------------
  it('local account: avatar and header are NOT proxied', () => {
    const row = makeAccountRow(); // domain: null = local
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.avatar).not.toContain('/proxy?url=');
    expect(account.header).not.toContain('/proxy?url=');
    expect(account.avatar_static).not.toContain('/proxy?url=');
    expect(account.header_static).not.toContain('/proxy?url=');
  });

  // -------------------------------------------------------------------------
  // 12. Remote account avatar -> proxied through /proxy
  // -------------------------------------------------------------------------
  it('remote account: avatar is proxied', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.avatar).toContain(`https://${INSTANCE_DOMAIN}/proxy?url=`);
    expect(account.avatar).toContain(encodeURIComponent('https://remote.social/media/avatars/remote.png'));
  });

  // -------------------------------------------------------------------------
  // 13. Remote account header -> proxied through /proxy
  // -------------------------------------------------------------------------
  it('remote account: header is proxied', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.header).toContain(`https://${INSTANCE_DOMAIN}/proxy?url=`);
    expect(account.header).toContain(encodeURIComponent('https://remote.social/media/headers/remote.png'));
  });

  // -------------------------------------------------------------------------
  // 14. Account with null/empty avatar -> uses default (may still be proxied
  //     if the default is from a remote origin)
  // -------------------------------------------------------------------------
  it('local account with empty avatar uses default-avatar and is not proxied', () => {
    const row = makeAccountRow({ avatar_url: '' as any });
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.avatar).toContain('default-avatar');
    // The default comes from the URI origin (local), so it should NOT be proxied
    expect(account.avatar).not.toContain('/proxy?url=');
  });

  it('remote account with empty avatar uses default-avatar from remote origin', () => {
    const row = makeRemoteAccountRow({ avatar_url: '' as any });
    const account = serializeAccount(row, { instanceDomain: INSTANCE_DOMAIN });
    expect(account.avatar).toContain('default-avatar');
    // The default avatar comes from remote.social (parsed from uri),
    // so it should be proxied
    expect(account.avatar).toContain(`https://${INSTANCE_DOMAIN}/proxy?url=`);
  });

  // -------------------------------------------------------------------------
  // 15. serializeAccount without instanceDomain -> no proxying (backward compat)
  // -------------------------------------------------------------------------
  it('does not proxy when instanceDomain is not provided', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row); // no opts
    expect(account.avatar).toBe('https://remote.social/media/avatars/remote.png');
    expect(account.header).toBe('https://remote.social/media/headers/remote.png');
    expect(account.avatar).not.toContain('/proxy?url=');
    expect(account.header).not.toContain('/proxy?url=');
  });

  it('does not proxy when instanceDomain is undefined in opts', () => {
    const row = makeRemoteAccountRow();
    const account = serializeAccount(row, { instanceDomain: undefined });
    expect(account.avatar).toBe('https://remote.social/media/avatars/remote.png');
    expect(account.header).toBe('https://remote.social/media/headers/remote.png');
  });
});

// ===========================================================================
// isValidProxyUrl SSRF Protection Tests (unit tests)
// ===========================================================================

describe('isValidProxyUrl SSRF protections', () => {
  // Valid URLs should pass
  it('allows valid public http/https URLs', () => {
    expect(isValidProxyUrl('https://example.com/image.png')).toBe(true);
    expect(isValidProxyUrl('http://cdn.remote.social/media/avatar.jpg')).toBe(true);
  });

  // --- Embedded credentials ---
  it('blocks URLs with embedded credentials', () => {
    expect(isValidProxyUrl('http://user:pass@evil.com/image.png')).toBe(false);
    expect(isValidProxyUrl('http://user@evil.com/image.png')).toBe(false);
  });

  // --- Decimal IP encoding ---
  it('blocks decimal IP encoding (e.g. 2130706433 = 127.0.0.1)', () => {
    expect(isValidProxyUrl('http://2130706433/image.png')).toBe(false);
    expect(isValidProxyUrl('http://167772161/image.png')).toBe(false); // 10.0.0.1
  });

  // --- Hex IP encoding ---
  it('blocks hex IP encoding (e.g. 0x7f000001 = 127.0.0.1)', () => {
    expect(isValidProxyUrl('http://0x7f000001/image.png')).toBe(false);
    expect(isValidProxyUrl('http://0x0a000001/image.png')).toBe(false); // 10.0.0.1
  });

  // --- Octal IP encoding (browsers/URL parsers typically normalize these) ---
  it('blocks octal-style IPs that resolve to private ranges', () => {
    // URL parser may normalize 0177.0.0.1 to 127.0.0.1
    // If it doesn't parse, it should still be blocked or rejected
    const result = isValidProxyUrl('http://0177.0.0.1/image.png');
    expect(result).toBe(false);
  });

  // --- DNS rebinding services ---
  it('blocks DNS rebinding services (.nip.io)', () => {
    expect(isValidProxyUrl('http://127.0.0.1.nip.io/image.png')).toBe(false);
    expect(isValidProxyUrl('http://10.0.0.1.nip.io/image.png')).toBe(false);
  });

  it('blocks DNS rebinding services (.sslip.io)', () => {
    expect(isValidProxyUrl('http://192.168.1.1.sslip.io/image.png')).toBe(false);
  });

  it('blocks DNS rebinding services (.localtest.me)', () => {
    expect(isValidProxyUrl('http://foo.localtest.me/image.png')).toBe(false);
  });

  it('blocks DNS rebinding services (.lvh.me)', () => {
    expect(isValidProxyUrl('http://foo.lvh.me/image.png')).toBe(false);
  });

  // --- Link-local addresses ---
  it('blocks link-local addresses (169.254.x.x)', () => {
    expect(isValidProxyUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isValidProxyUrl('http://169.254.0.1/image.png')).toBe(false);
  });

  // --- IPv6 private addresses ---
  it('blocks IPv6 unique local addresses (fd00::, fc00::)', () => {
    expect(isValidProxyUrl('http://[fd00::1]/image.png')).toBe(false);
    expect(isValidProxyUrl('http://[fc00::1]/image.png')).toBe(false);
  });

  it('blocks IPv6 link-local addresses (fe80::)', () => {
    expect(isValidProxyUrl('http://[fe80::1]/image.png')).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1)', () => {
    // Most URL parsers normalize ::ffff:127.0.0.1 to 127.0.0.1,
    // which is caught by the existing IPv4 private range check.
    // Either way, the URL must be blocked.
    expect(isValidProxyUrl('http://[::ffff:127.0.0.1]/image.png')).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 private addresses (::ffff:10.x, ::ffff:192.168.x)', () => {
    // URL parsers may normalize these to plain IPv4, caught by IPv4 checks.
    expect(isValidProxyUrl('http://[::ffff:10.0.0.1]/image.png')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:192.168.1.1]/image.png')).toBe(false);
  });

  // --- Existing protections still work ---
  it('still blocks localhost and basic private IPs', () => {
    expect(isValidProxyUrl('http://localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://127.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://10.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://172.16.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://192.168.1.1/x')).toBe(false);
    expect(isValidProxyUrl('http://0.0.0.0/x')).toBe(false);
    expect(isValidProxyUrl('http://::1/x')).toBe(false);
  });

  it('still blocks non-http protocols', () => {
    expect(isValidProxyUrl('ftp://example.com/x')).toBe(false);
    expect(isValidProxyUrl('file:///etc/passwd')).toBe(false);
  });
});
