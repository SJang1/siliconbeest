import { env } from 'cloudflare:workers';

export interface FeedCursorV1 {
  readonly v: 1;
  readonly feedKey: string;
  readonly before: { readonly sortAtMs: number; readonly entityId: string };
  readonly catalogVersion: number;
}

function cursorSecret(): string {
  const dedicated = Reflect.get(env, 'FEED_CURSOR_HMAC_KEY');
  if (typeof dedicated === 'string' && dedicated.length >= 32) return dedicated;
  const fallback = Reflect.get(env, 'OTP_ENCRYPTION_KEY');
  if (typeof fallback === 'string' && fallback.length >= 32) return fallback;
  throw new Error('FEED_CURSOR_HMAC_KEY secret is not configured');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(payload: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(cursorSecret()),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
}

export async function encodeFeedCursor(cursor: FeedCursorV1): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(cursor));
  return `fc1.${base64Url(payload)}.${base64Url(await hmac(payload))}`;
}

export async function decodeFeedCursor(value: string, expectedFeedKey: string): Promise<FeedCursorV1 | null> {
  const [prefix, payloadPart, signaturePart, extra] = value.split('.');
  if (prefix !== 'fc1' || !payloadPart || !signaturePart || extra !== undefined) return null;
  try {
    const payload = decodeBase64Url(payloadPart);
    const provided = decodeBase64Url(signaturePart);
    const expected = await hmac(payload);
    if (provided.length !== expected.length) return null;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= provided[index] ^ expected[index];
    if (difference !== 0) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as Partial<FeedCursorV1>;
    if (parsed.v !== 1 || parsed.feedKey !== expectedFeedKey
      || !parsed.before || !Number.isSafeInteger(parsed.before.sortAtMs)
      || typeof parsed.before.entityId !== 'string'
      || !Number.isSafeInteger(parsed.catalogVersion)) return null;
    return parsed as FeedCursorV1;
  } catch {
    return null;
  }
}

export async function buildFeedLinkHeader(
  baseUrl: string,
  rows: readonly { id: string; sort_at_ms?: number | null; created_at: string }[],
  limit: number,
  feedKey: string,
  catalogVersion = 1,
): Promise<string> {
  if (rows.length === 0) return '';
  const cursorFor = async (row: { id: string; sort_at_ms?: number | null; created_at: string }) => encodeFeedCursor({
    v: 1,
    feedKey,
    before: {
      sortAtMs: row.sort_at_ms ?? Date.parse(row.created_at),
      entityId: row.id,
    },
    catalogVersion,
  });
  const last = rows[rows.length - 1];
  const first = rows[0];
  return [
    `<${baseUrl}?max_id=${encodeURIComponent(await cursorFor(last))}&limit=${limit}>; rel="next"`,
    `<${baseUrl}?min_id=${encodeURIComponent(await cursorFor(first))}&limit=${limit}>; rel="prev"`,
  ].join(', ');
}
