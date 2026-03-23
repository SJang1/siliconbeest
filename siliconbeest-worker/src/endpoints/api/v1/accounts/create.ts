import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';

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
    avatar: (row.avatar_url as string) || '',
    avatar_static: (row.avatar_static_url as string) || '',
    header: (row.header_url as string) || '',
    header_static: (row.header_static_url as string) || '',
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

  const regMode = c.env.REGISTRATION_MODE;
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

  const approved = regMode === 'approval' ? 0 : 1;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO accounts (id, username, domain, display_name, note, uri, url, locked, bot, discoverable, statuses_count, followers_count, following_count, created_at, updated_at)
       VALUES (?1, ?2, NULL, '', '', ?3, ?4, 0, 0, 1, 0, 0, 0, ?5, ?5)`,
    ).bind(accountId, body.username, actorUri, `https://${domain}/@${body.username}`, now),
    c.env.DB.prepare(
      `INSERT INTO users (id, account_id, email, encrypted_password, locale, confirmed_at, role, approved, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7, ?6, ?6)`,
    ).bind(userId, accountId, body.email, encryptedPassword, body.locale || 'en', now, approved),
    c.env.DB.prepare(
      `INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(keyId, accountId, pubKeyPem, privKeyPem, `${actorUri}#main-key`, now),
  ]);

  const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(accountId).first();

  return c.json(serializeAccount(account as Record<string, unknown>, domain));
});

export default app;
