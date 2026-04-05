import { env } from 'cloudflare:test';

// ---------------------------------------------------------------------------
// Test RSA key pair (generated once at module level, cached for reuse)
// ---------------------------------------------------------------------------
let testKeyPair: { publicPem: string; privatePem: string } | null = null;

async function getTestKeyPair(): Promise<{ publicPem: string; privatePem: string }> {
  if (testKeyPair) return testKeyPair;

  const kp = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey);
  const privBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey);

  const toBase64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const pubPem = `-----BEGIN PUBLIC KEY-----\n${toBase64(pubBuf)}\n-----END PUBLIC KEY-----`;
  const privPem = `-----BEGIN PRIVATE KEY-----\n${toBase64(privBuf)}\n-----END PRIVATE KEY-----`;

  testKeyPair = { publicPem: pubPem, privatePem: privPem };
  return testKeyPair;
}

// Import all migration SQL files at build time using Vite's ?raw imports.
// This keeps test schema in sync with production migrations automatically.
// When adding a new migration file, add an import here.
import m0001 from '../../migrations/0001_initial_schema.sql?raw';
import m0002 from '../../migrations/0002_relays.sql?raw';
import m0003 from '../../migrations/0003_status_mutes.sql?raw';
import m0004 from '../../migrations/0004_emoji_reactions.sql?raw';
import m0005 from '../../migrations/0005_announcements_published_at.sql?raw';
import m0006 from '../../migrations/0006_instances_health.sql?raw';
import m0007 from '../../migrations/0007_accounts_inbox.sql?raw';
import m0008 from '../../migrations/0008_preview_cards.sql?raw';
import m0009a from '../../migrations/0009_accounts_fields.sql?raw';
import m0009b from '../../migrations/0009_accounts_remote_columns.sql?raw';
import m0010 from '../../migrations/0010_reports_assigned.sql?raw';
import m0011 from '../../migrations/0011_conversations_ap_uri.sql?raw';
import m0012 from '../../migrations/0012_ed25519_keys.sql?raw';
import m0013 from '../../migrations/0013_quote_posts.sql?raw';
import m0014 from '../../migrations/0014_notification_emoji.sql?raw';
import m0015 from '../../migrations/0015_statuses_pinned.sql?raw';
import m0016 from '../../migrations/0016_account_migration.sql?raw';
import m0017 from '../../migrations/0017_email_verification_passkeys.sql?raw';
import m0018 from '../../migrations/0018_media_proxy_cache.sql?raw';
import m0020 from '../../migrations/0020_emoji_payload_jit.sql?raw';
import m0021 from '../../migrations/0021_accounts_emoji_tags.sql?raw';
import m0022 from '../../migrations/0022_hash_oauth_tokens.sql?raw';
import m0023 from '../../migrations/0023_feature_gaps.sql?raw';
import m0024 from '../../migrations/0024_i18n_registration_reason.sql?raw';
import m0025 from '../../migrations/0025_user_default_privacy.sql?raw';

const MIGRATIONS: string[] = [
  m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008,
  m0009a, m0009b, m0010, m0011, m0012, m0013, m0014, m0015,
  m0016, m0017, m0018, m0020, m0021, m0022, m0023, m0024, m0025,
];

/**
 * Apply all D1 migrations in order.
 * SQL files are imported at build time via Vite ?raw imports,
 * so this works in the Cloudflare Workers test runtime.
 */
export async function applyMigration() {
  for (const sql of MIGRATIONS) {
    // Split SQL into individual statements and execute one by one.
    // D1 exec() in the test runtime can be finicky with multi-statement SQL.
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (e: any) {
        const msg = e?.message || '';
        if (msg.includes('already exists') || msg.includes('duplicate column')) {
          continue;
        }
        throw e;
      }
    }
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createTestUser(username: string, opts?: { email?: string; role?: string }) {
  const id = crypto.randomUUID();
  const email = opts?.email || username + '@test.local';
  const role = opts?.role || 'user';
  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  const uri = 'https://test.siliconbeest.local/users/' + username;
  const appId = crypto.randomUUID();
  const clientId = crypto.randomUUID().replace(/-/g, '');
  const clientSecret = crypto.randomUUID().replace(/-/g, '');

  // Use real RSA PEM keys so Fedify's actor dispatcher can parse them
  const keys = await getTestKeyPair();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, NULL, ?, '', ?, ?, ?, ?)").bind(id, username, username, uri, 'https://test.siliconbeest.local/@' + username, now, now),
    env.DB.prepare("INSERT INTO users (id, account_id, email, encrypted_password, role, approved, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)").bind(id, id, email, 'dummy_hash', role, now, now, now),
    env.DB.prepare("INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, keys.publicPem, keys.privatePem, uri + '#main-key', now),
    env.DB.prepare("INSERT INTO oauth_applications (id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)").bind(appId, 'Test App', 'urn:ietf:wg:oauth:2.0:oob', clientId, clientSecret, 'read write follow push', now, now),
    env.DB.prepare("INSERT INTO oauth_access_tokens (id, token, token_hash, application_id, user_id, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), token, tokenHash, appId, id, 'read write follow push', now),
  ]);

  return { accountId: id, userId: id, token };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}
