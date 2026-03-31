/**
 * Domain block checking for federation.
 *
 * Checks the domain_blocks table and uses KV cache to avoid
 * repeated D1 queries during inbox processing bursts.
 */

export interface DomainBlockResult {
  blocked: boolean; // true if severity=suspend (drop all activities)
  severity: 'suspend' | 'silence' | null;
  rejectMedia?: boolean;
  rejectReports?: boolean;
}

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = 'domblk:';

export async function isDomainBlocked(
  db: D1Database,
  cache: KVNamespace | null,
  domain: string,
): Promise<DomainBlockResult> {
  if (!domain) return { blocked: false, severity: null };

  const lowerDomain = domain.toLowerCase();

  // 1. Check KV cache
  if (cache) {
    const cached = await cache.get(`${CACHE_PREFIX}${lowerDomain}`, 'json');
    if (cached !== null) return cached as DomainBlockResult;
  }

  // 2. D1 lookup
  const row = await db
    .prepare(
      'SELECT severity, reject_media, reject_reports FROM domain_blocks WHERE domain = ?1 LIMIT 1',
    )
    .bind(lowerDomain)
    .first<{ severity: string; reject_media: number; reject_reports: number }>();

  const result: DomainBlockResult = row
    ? {
        blocked: row.severity === 'suspend',
        severity: row.severity as 'suspend' | 'silence',
        rejectMedia: !!row.reject_media,
        rejectReports: !!row.reject_reports,
      }
    : { blocked: false, severity: null };

  // 3. Cache result (cache misses too, to avoid repeated DB queries)
  if (cache) {
    await cache.put(`${CACHE_PREFIX}${lowerDomain}`, JSON.stringify(result), {
      expirationTtl: CACHE_TTL,
    });
  }

  return result;
}

/**
 * Extract the domain from an actor URI.
 */
export function extractDomain(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}
