import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { createDefaultImages } from '../../../../utils/defaultImages';
import { generateToken } from '../../../../utils/crypto';
import { sendConfirmation } from '../../../../services/email';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  const hashArr = new Uint8Array(bits);
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(hashArr).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

function serializeAccount(row: Record<string, unknown>, domain: string) {
  const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
  return {
    id: row.id as string,
    username: row.username as string,
    acct,
    display_name: (row.display_name as string) || '',
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note: (row.note as string) || '',
    url: (row.url as string) || `https://${domain}/@${row.username}`,
    uri: row.uri as string,
    avatar: (row.avatar_url as string) || null,
    avatar_static: (row.avatar_static_url as string) || null,
    header: (row.header_url as string) || null,
    header_static: (row.header_static_url as string) || null,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis: [],
    fields: [],
  };
}

const app = new Hono<HonoEnv>();

app.post('/', async (c) => {
  const body = await c.req.json<{
    username: string;
    email: string;
    password: string;
    agreement: boolean;
    locale?: string;
  }>();

  if (!body.username || !body.email || !body.password) {
    throw new AppError(422, 'Validation failed', 'Missing required fields');
  }

  if (!body.agreement) {
    throw new AppError(422, 'Validation failed', 'Agreement must be accepted');
  }

  // Check registration mode from DB settings first, fall back to env var
  const dbRegMode = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'registration_mode'").first<{ value: string }>();
  const regMode = dbRegMode?.value || c.env.REGISTRATION_MODE || 'closed';
  if (regMode === 'none' || regMode === 'closed') {
    throw new AppError(403, 'Registrations are not allowed');
  }

  const domain = c.env.INSTANCE_DOMAIN;
  const now = new Date().toISOString();
  const accountId = generateULID();
  const userId = generateULID();
  const keyId = generateULID();
  const actorUri = `https://${domain}/users/${body.username}`;

  // Check username uniqueness
  const existing = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL',
  ).bind(body.username).first();
  if (existing) {
    throw new AppError(422, 'Validation failed', 'Username is already taken');
  }

  // Check email uniqueness
  const existingEmail = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?1',
  ).bind(body.email).first();
  if (existingEmail) {
    throw new AppError(422, 'Validation failed', 'Email is already taken');
  }

  const encryptedPassword = await hashPassword(body.password);

  // Generate RSA keypair for federation
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pubKeyData = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
  const privKeyData = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;
  const pubKeyPem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(pubKeyData)))}\n-----END PUBLIC KEY-----`;
  const privKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(privKeyData)))}\n-----END PRIVATE KEY-----`;

  // Generate Ed25519 keypair for Object Integrity Proofs (FEP-8b32)
  const ed25519KeyPair = await crypto.subtle.generateKey(
    'Ed25519',
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const ed25519PubRaw = await crypto.subtle.exportKey('raw', ed25519KeyPair.publicKey) as ArrayBuffer;
  const ed25519PrivPkcs8 = await crypto.subtle.exportKey('pkcs8', ed25519KeyPair.privateKey) as ArrayBuffer;
  const ed25519PubB64 = btoa(String.fromCharCode(...new Uint8Array(ed25519PubRaw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ed25519PrivB64 = btoa(String.fromCharCode(...new Uint8Array(ed25519PrivPkcs8))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const approved = regMode === 'approval' ? 0 : 1;

  // Generate default avatar and header images
  const { avatarUrl, headerUrl } = await createDefaultImages(
    c.env.MEDIA_BUCKET, domain, accountId, body.username,
  );

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO accounts (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url, header_url, header_static_url, locked, bot, discoverable, statuses_count, followers_count, following_count, created_at, updated_at)
       VALUES (?1, ?2, NULL, '', '', ?3, ?4, ?6, ?6, ?7, ?7, 0, 0, 1, 0, 0, 0, ?5, ?5)`,
    ).bind(accountId, body.username, actorUri, `https://${domain}/@${body.username}`, now, avatarUrl, headerUrl),
    c.env.DB.prepare(
      `INSERT INTO users (id, account_id, email, encrypted_password, locale, confirmed_at, role, approved, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'user', ?6, ?7, ?7)`,
    ).bind(userId, accountId, body.email, encryptedPassword, body.locale || 'en', approved, now),
    c.env.DB.prepare(
      `INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, ed25519_public_key, ed25519_private_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(keyId, accountId, pubKeyPem, privKeyPem, `${actorUri}#main-key`, ed25519PubB64, ed25519PrivB64, now),
  ]);

  // Generate email confirmation token and store in KV
  const confirmToken = generateToken(64);
  await c.env.CACHE.put(
    'email_confirm:' + confirmToken,
    JSON.stringify({ userId, email: body.email }),
    { expirationTtl: 86400 },
  );
  await c.env.DB.prepare('UPDATE users SET confirmation_token = ?1 WHERE id = ?2').bind(confirmToken, userId).run();

  // Send confirmation email (best-effort)
  try {
    await sendConfirmation(c.env, body.email, confirmToken);
  } catch { /* email queue failure should not block registration */ }

  return c.json({ confirmation_required: true });
});

export default app;
