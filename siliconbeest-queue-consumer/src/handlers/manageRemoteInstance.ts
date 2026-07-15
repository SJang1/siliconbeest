import { env } from 'cloudflare:workers';
import type {
  RefreshRemoteInstanceMessage,
  ResetRemoteInstanceCacheMessage,
} from '../shared/types/queue';
import { getSuspendedDomains } from '../../../packages/shared/domain-blocks';

const PAGE_SIZE = 100;

interface RemoteAccountCacheRow {
  id: string;
  uri: string;
  public_key_id: string | null;
  inbox_url: string | null;
  shared_inbox_url: string | null;
}

export async function handleRefreshRemoteInstance(
  msg: RefreshRemoteInstanceMessage,
): Promise<void> {
  const domain = msg.domain.trim().toLowerCase();
  const suspended = await getSuspendedDomains(env.DB, [domain]);
  if (suspended.has(domain)) {
    console.log(`[federation-admin] Skipping refresh for suspended domain ${domain}`);
    return;
  }

  const rows = await listRemoteAccounts(domain, msg.cursor);
  if (rows.length > 0) {
    await env.QUEUE_INTERNAL.sendBatch(rows.map((row) => ({
      body: {
        type: 'fetch_remote_account' as const,
        actorUri: row.uri,
        forceRefresh: true,
      },
    })));
  }

  if (rows.length === PAGE_SIZE) {
    await env.QUEUE_INTERNAL.send({
      type: 'refresh_remote_instance',
      domain,
      cursor: rows[rows.length - 1].id,
    });
  }

  console.log(`[federation-admin] Queued ${rows.length} actor refreshes for ${domain}`);
}

export async function handleResetRemoteInstanceCache(
  msg: ResetRemoteInstanceCacheMessage,
): Promise<void> {
  const domain = msg.domain.trim().toLowerCase();
  const rows = await listRemoteAccounts(domain, msg.cursor);
  const cacheKeys = new Set<string>();
  const fedifyKeys = new Set<string>();

  if (!msg.cursor) {
    cacheKeys.add(`nodeinfo:${domain}`);
    cacheKeys.add(`sig-pref:${domain}`);
    addFedifyOriginKeys(fedifyKeys, new URL(`https://${domain}/`));
  }

  for (const row of rows) {
    cacheKeys.add(`actor:${row.uri}`);
    fedifyKeys.add(encodeFedifyKey(['_fedify', 'remoteDocument', row.uri]));

    if (row.public_key_id) {
      fedifyKeys.add(encodeFedifyKey(['_fedify', 'publicKey', row.public_key_id]));
      fedifyKeys.add(encodeFedifyKey([
        '_fedify',
        'publicKey',
        '__fetchError',
        row.public_key_id,
      ]));
    }

    for (const rawUrl of [row.uri, row.inbox_url, row.shared_inbox_url]) {
      if (!rawUrl) continue;
      try {
        const url = new URL(rawUrl);
        cacheKeys.add(`sig-pref:${url.hostname.toLowerCase()}`);
        addFedifyOriginKeys(fedifyKeys, url);
      } catch {
        // Ignore malformed legacy URLs while clearing every valid scoped key.
      }
    }
  }

  await Promise.all([
    deleteKvKeys(env.CACHE, cacheKeys),
    deleteKvKeys(env.FEDIFY_KV, fedifyKeys),
  ]);

  if (rows.length === PAGE_SIZE) {
    await env.QUEUE_INTERNAL.send({
      type: 'reset_remote_instance_cache',
      domain,
      cursor: rows[rows.length - 1].id,
    });
  }

  console.log(JSON.stringify({
    message: 'remote instance caches cleared',
    domain,
    cacheKeys: cacheKeys.size,
    fedifyKeys: fedifyKeys.size,
  }));
}

async function listRemoteAccounts(
  domain: string,
  cursor?: string,
): Promise<RemoteAccountCacheRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, uri, public_key_id, inbox_url, shared_inbox_url
     FROM accounts
     WHERE domain = ?1 AND uri IS NOT NULL AND (?2 IS NULL OR id > ?2)
     ORDER BY id ASC
     LIMIT ?3`,
  )
    .bind(domain, cursor ?? null, PAGE_SIZE)
    .all<RemoteAccountCacheRow>();
  return results ?? [];
}

function addFedifyOriginKeys(keys: Set<string>, url: URL): void {
  keys.add(encodeFedifyKey(['_fedify', 'httpMessageSignaturesSpec', url.origin]));
  keys.add(encodeFedifyKey(['_fedify', 'circuit', url.host.toLowerCase()]));
}

export function encodeFedifyKey(key: readonly string[]): string {
  return JSON.stringify(key);
}

async function deleteKvKeys(
  namespace: KVNamespace,
  keys: Iterable<string>,
): Promise<void> {
  const values = [...keys];
  const concurrency = 50;
  for (let offset = 0; offset < values.length; offset += concurrency) {
    await Promise.all(
      values.slice(offset, offset + concurrency).map((key) => namespace.delete(key)),
    );
  }
}
