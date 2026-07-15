/**
 * Domain block checking for federation.
 *
 * Checks the domain_blocks table and uses KV cache to avoid
 * repeated D1 queries during inbox processing bursts.
 */

export interface DomainBlockResult {
  blocked: boolean; // true if severity=suspend (drop all activities)
  severity: 'suspend' | 'silence' | 'noop' | null;
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
        severity: row.severity as 'suspend' | 'silence' | 'noop',
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
 * Return the subset of domains that are fully suspended.
 *
 * Outbound delivery uses D1 directly so a just-created suspension cannot be
 * bypassed briefly by an eventually-consistent cached negative lookup.
 */
export async function getSuspendedDomains(
  db: D1Database,
  domains: Iterable<string>,
): Promise<Set<string>> {
  const normalized = [...new Set(
    [...domains].map((domain) => domain.trim().toLowerCase()).filter(Boolean),
  )];
  const suspended = new Set<string>();
  const batchSize = 100;

  for (let offset = 0; offset < normalized.length; offset += batchSize) {
    const batch = normalized.slice(offset, offset + batchSize);
    const placeholders = batch.map((_, index) => `?${index + 1}`).join(', ');
    const { results } = await db.prepare(
      `SELECT domain FROM domain_blocks
       WHERE severity = 'suspend' AND domain IN (${placeholders})`,
    )
      .bind(...batch)
      .all<{ domain: string }>();
    for (const row of results ?? []) suspended.add(row.domain.toLowerCase());
  }

  return suspended;
}

/**
 * Resolve every known instance identity behind an inbox URL.
 *
 * ActivityPub allows an actor and its inbox/sharedInbox to use different
 * hosts.  Legacy delivery messages only contain the inbox URL, so the final
 * outbound gate also consults stored accounts and accepted relays instead of
 * treating the transport host as the instance identity.
 */
export async function getDeliveryTargetDomains(
  db: D1Database,
  inboxUrl: string,
): Promise<Set<string>> {
  const domains = new Set<string>();
  try {
    domains.add(new URL(inboxUrl).hostname.toLowerCase());
  } catch {
    return domains;
  }

  const { results } = await db.prepare(
    `SELECT 'domain' AS kind, domain AS value
     FROM accounts
     WHERE domain IS NOT NULL AND (inbox_url = ?1 OR shared_inbox_url = ?1)
     UNION
     SELECT 'actor_uri' AS kind, actor_uri AS value
     FROM relays
     WHERE actor_uri IS NOT NULL AND inbox_url = ?1`,
  )
    .bind(inboxUrl)
    .all<{ kind: 'domain' | 'actor_uri'; value: string }>();

  for (const row of results ?? []) {
    if (row.kind === 'domain') {
      domains.add(row.value.toLowerCase());
      continue;
    }
    try {
      domains.add(new URL(row.value).hostname.toLowerCase());
    } catch {
      // Ignore malformed legacy relay actor URIs; the inbox host still applies.
    }
  }

  return domains;
}

/**
 * Return queued inbox URLs that belong to a suspended actor/relay identity.
 * This is the batched equivalent of getDeliveryTargetDomains for Fedify
 * fanout payloads, whose transport host can differ from every actor host.
 */
export async function getSuspendedDeliveryInboxes(
  db: D1Database,
  inboxUrls: Iterable<string>,
): Promise<Set<string>> {
  const inboxes = [...new Set([...inboxUrls].filter(Boolean))];
  const identityDomainsByInbox = new Map<string, Set<string>>();
  const batchSize = 100;

  for (let offset = 0; offset < inboxes.length; offset += batchSize) {
    const batch = inboxes.slice(offset, offset + batchSize);
    const values = batch.map((_, index) => `(?${index + 1})`).join(', ');
    const { results } = await db.prepare(
      `WITH requested(inbox_url) AS (VALUES ${values})
       SELECT DISTINCT requested.inbox_url, 'domain' AS kind, accounts.domain AS value
       FROM requested
       JOIN accounts
         ON accounts.inbox_url = requested.inbox_url
         OR accounts.shared_inbox_url = requested.inbox_url
       WHERE accounts.domain IS NOT NULL
       UNION
       SELECT DISTINCT requested.inbox_url, 'actor_uri' AS kind, relays.actor_uri AS value
       FROM requested
       JOIN relays ON relays.inbox_url = requested.inbox_url
       WHERE relays.actor_uri IS NOT NULL`,
    )
      .bind(...batch)
      .all<{ inbox_url: string; kind: 'domain' | 'actor_uri'; value: string }>();

    for (const row of results ?? []) {
      let domain: string;
      if (row.kind === 'domain') {
        domain = row.value.toLowerCase();
      } else {
        try {
          domain = new URL(row.value).hostname.toLowerCase();
        } catch {
          continue;
        }
      }
      const domains = identityDomainsByInbox.get(row.inbox_url) ?? new Set<string>();
      domains.add(domain);
      identityDomainsByInbox.set(row.inbox_url, domains);
    }
  }

  const allIdentityDomains = new Set<string>();
  for (const domains of identityDomainsByInbox.values()) {
    for (const domain of domains) allIdentityDomains.add(domain);
  }
  const suspendedDomains = await getSuspendedDomains(db, allIdentityDomains);
  const suspendedInboxes = new Set<string>();
  for (const [inbox, domains] of identityDomainsByInbox) {
    if ([...domains].some((domain) => suspendedDomains.has(domain))) {
      suspendedInboxes.add(inbox);
    }
  }
  return suspendedInboxes;
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
