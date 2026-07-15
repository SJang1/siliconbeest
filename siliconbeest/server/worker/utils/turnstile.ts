/**
 * Cloudflare Turnstile CAPTCHA verification utility.
 *
 * Verifies a Turnstile token against the Cloudflare siteverify endpoint.
 */
import { env } from 'cloudflare:workers';
import { getUserAgent } from './repository';

export type TurnstileVerificationOutcome = 'passed' | 'rejected' | 'server_error';

interface TurnstileVerificationResponse {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * Keep a rejected challenge separate from a Turnstile service failure. Login
 * may continue during a genuine verification outage, but an invalid or expired
 * challenge must never be treated as an outage.
 */
export async function verifyTurnstileOutcome(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<TurnstileVerificationOutcome> {
  const payload: Record<string, string> = {
    secret: secretKey,
    response: token,
  };
  if (remoteIp) {
    payload.remoteip = remoteIp;
  }

  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getUserAgent(),
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) return 'server_error';

    const data = await res.json() as TurnstileVerificationResponse;
    if (data.success === true) return 'passed';
    if (data.success !== false) return 'server_error';

    return data['error-codes']?.includes('internal-error')
      ? 'server_error'
      : 'rejected';
  } catch {
    return 'server_error';
  }
}

export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<boolean> {
  const outcome = await verifyTurnstileOutcome(token, secretKey, remoteIp);
  if (outcome === 'server_error') {
    throw new Error('Turnstile verification service unavailable');
  }
  return outcome === 'passed';
}

/**
 * Read turnstile settings from D1, with KV cache (2-min TTL).
 * Returns { enabled, siteKey, secretKey } or null values when not configured.
 */
export async function getTurnstileSettings(
): Promise<{ enabled: boolean; siteKey: string; secretKey: string }> {
  const CACHE_KEY = 'settings:turnstile';
  const cached = await env.CACHE.get(CACHE_KEY, 'json');

  if (cached) return cached as { enabled: boolean; siteKey: string; secretKey: string };

  const { results } = await env.DB
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('turnstile_enabled', 'turnstile_site_key', 'turnstile_secret_key')",
    )
    .all();

  const map: Record<string, string> = Object.fromEntries(
    (results ?? []).map((row) => [row.key as string, row.value as string]),
  );

  const settings = {
    enabled: map.turnstile_enabled === '1',
    siteKey: map.turnstile_site_key ?? '',
    secretKey: map.turnstile_secret_key ?? '',
  };

  await env.CACHE.put(CACHE_KEY, JSON.stringify(settings), { expirationTtl: 120 });
  return settings;
}
