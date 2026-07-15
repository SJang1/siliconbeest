import type { Context } from 'hono';
import { generateToken } from '../utils/crypto';
import { getCookieValue } from '../utils/authCookie';
import {
  getTurnstileSettings,
  verifyTurnstileOutcome,
} from '../utils/turnstile';

export const LOGIN_PREFLIGHT_COOKIE = 'siliconbeest_login_preflight';
const LOGIN_PREFLIGHT_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_PREFLIGHT_PURPOSE = 'siliconbeest-login-preflight-v1';
const LOGIN_PATHS = new Set(['/login', '/aurora/login', '/old/login']);

export interface LoginPreflightStatus {
  required: boolean;
  passed: boolean;
  site_key: string;
}

interface ActiveTurnstileSettings {
  siteKey: string;
  secretKey: string;
}

type TurnstileMode =
  | { type: 'disabled' }
  | { type: 'required'; settings: ActiveTurnstileSettings }
  | { type: 'server_error' };

async function getTurnstileMode(): Promise<TurnstileMode> {
  try {
    const settings = await getTurnstileSettings();
    if (!settings.enabled) return { type: 'disabled' };
    if (!settings.siteKey || !settings.secretKey) return { type: 'server_error' };
    return {
      type: 'required',
      settings: { siteKey: settings.siteKey, secretKey: settings.secretKey },
    };
  } catch (error) {
    console.error('[login/preflight/settings]', error);
    return { type: 'server_error' };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function importSigningKey(
  secretKey: string,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function getSignedPayload(expiresAt: number, nonce: string): string {
  return `${LOGIN_PREFLIGHT_PURPOSE}.${expiresAt}.${nonce}`;
}

async function createPreflightToken(secretKey: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + LOGIN_PREFLIGHT_MAX_AGE_SECONDS;
  const nonce = generateToken(32);
  const payload = getSignedPayload(expiresAt, nonce);
  const key = await importSigningKey(secretKey, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${expiresAt}.${nonce}.${bytesToHex(new Uint8Array(signature))}`;
}

async function isValidPreflightToken(token: string, secretKey: string): Promise<boolean> {
  const [expiresAtValue, nonce, signatureValue, ...extra] = token.split('.');
  if (extra.length > 0 || !expiresAtValue || !nonce || !signatureValue) return false;
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return false;

  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;

  const signature = hexToBytes(signatureValue);
  if (!signature) return false;

  const key = await importSigningKey(secretKey, 'verify');
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(getSignedPayload(expiresAt, nonce)),
  );
}

function setLoginPreflightCookie(c: Context, token: string): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  const parts = [
    `${LOGIN_PREFLIGHT_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${LOGIN_PREFLIGHT_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '), { append: true });
}

export function clearLoginPreflightCookie(c: Context): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  const parts = [
    `${LOGIN_PREFLIGHT_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '), { append: true });
}

export async function getLoginPreflightStatus(
  cookieHeader: string | undefined,
): Promise<LoginPreflightStatus> {
  const mode = await getTurnstileMode();
  if (mode.type !== 'required') {
    return { required: false, passed: true, site_key: '' };
  }

  let token: string | null;
  try {
    token = getCookieValue(cookieHeader, LOGIN_PREFLIGHT_COOKIE);
  } catch {
    return { required: true, passed: false, site_key: mode.settings.siteKey };
  }

  try {
    const passed = token
      ? await isValidPreflightToken(token, mode.settings.secretKey)
      : false;
    return { required: true, passed, site_key: mode.settings.siteKey };
  } catch (error) {
    console.error('[login/preflight/status]', error);
    return { required: false, passed: true, site_key: '' };
  }
}

export async function isLoginPreflightSatisfied(
  cookieHeader: string | undefined,
): Promise<boolean> {
  const status = await getLoginPreflightStatus(cookieHeader);
  return !status.required || status.passed;
}

export async function completeLoginPreflight(
  c: Context,
  turnstileToken: string,
): Promise<'passed' | 'rejected'> {
  const mode = await getTurnstileMode();
  if (mode.type !== 'required') return 'passed';
  if (!turnstileToken) return 'rejected';

  const remoteIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
  const outcome = await verifyTurnstileOutcome(
    turnstileToken,
    mode.settings.secretKey,
    remoteIp,
  );
  if (outcome === 'rejected') return 'rejected';

  try {
    setLoginPreflightCookie(c, await createPreflightToken(mode.settings.secretKey));
  } catch (error) {
    // Signing failures are genuine server failures. The status and login checks
    // use the same crypto primitives and will fail open if they remain broken.
    console.error('[login/preflight/cookie]', error);
  }
  return 'passed';
}

export function getSafeLoginReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/login';

  try {
    const parsed = new URL(value, 'https://login.invalid');
    if (parsed.origin !== 'https://login.invalid' || !LOGIN_PATHS.has(parsed.pathname)) {
      return '/login';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/login';
  }
}

export function getFailedLoginPreflightReturnTo(value: string | null): string {
  const safeReturnTo = getSafeLoginReturnTo(value);
  const parsed = new URL(safeReturnTo, 'https://login.invalid');
  parsed.searchParams.set('turnstile_error', 'failed');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
