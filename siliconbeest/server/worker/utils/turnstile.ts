/**
 * Cloudflare Turnstile CAPTCHA verification utility.
 *
 * Verifies a Turnstile token against the Cloudflare siteverify endpoint.
 * Returns true when the token is valid, false otherwise.
 */
export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<boolean> {
  const payload: Record<string, string> = {
    secret: secretKey,
    response: token,
  };
  if (remoteIp) {
    payload.remoteip = remoteIp;
  }

  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SiliconBeest/1.0 (+https://github.com/SJang1/siliconbeest)',
      },
      body: JSON.stringify(payload),
    },
  );

  const data: { success: boolean } = await res.json();
  return data.success;
}

/**
 * Read turnstile settings from D1, with KV cache (2-min TTL).
 * Returns { enabled, siteKey, secretKey } or null values when not configured.
 */
export async function getTurnstileSettings(
  db: D1Database,
  cache: KVNamespace,
): Promise<{ enabled: boolean; siteKey: string; secretKey: string }> {
  const CACHE_KEY = 'settings:turnstile';
  const cached = await cache.get(CACHE_KEY, 'json');

  if (cached) return cached as { enabled: boolean; siteKey: string; secretKey: string };

  const { results } = await db
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

  await cache.put(CACHE_KEY, JSON.stringify(settings), { expirationTtl: 120 });
  return settings;
}
