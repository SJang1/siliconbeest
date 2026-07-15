/**
 * Fedify NodeInfo Dispatcher
 *
 * Registers a NodeInfo dispatcher that returns the same data as
 * the existing `endpoints/wellknown/nodeinfo.ts` implementation.
 *
 * Fedify automatically handles:
 *   - /.well-known/nodeinfo  (the JRD document with links)
 *   - /nodeinfo/2.1          (the actual NodeInfo JSON)
 */

import type { Federation, NodeInfo } from '@fedify/fedify';
import type { FedifyContextData } from '../fedify';
import { SILICONBEEST_VERSION } from '../../version';
import { getInstanceTitle, getSetting } from '../../services/instance';
import { env } from 'cloudflare:workers';
import { getRepositoryUrl } from '../../utils/repository';

const STATS_CACHE_KEY = 'nodeinfo:stats:fedify';
const STATS_CACHE_TTL = 3600; // 1 hour

interface NodeInfoStats {
  activeUserCount: number;
  activeMonthUserCount: number;
  activeHalfyearUserCount: number;
  statusCount: number;
  domainCount: number;
  localComments: number;
}

/**
 * Query usage statistics from D1, with KV caching.
 */
async function getStats(): Promise<NodeInfoStats> {
  const cached = await env.CACHE.get(STATS_CACHE_KEY, 'json');
  if (cached) return cached as NodeInfoStats;

  const activeMonthSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const activeHalfyearSince = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  const [usersResult, activeMonthUserCountResult, activeHalfyearUserCountResult, statusesResult, domainsResult, commentsResult] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL`).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT a.id) AS cnt
       FROM accounts a
       JOIN users u ON u.account_id = a.id
       WHERE a.domain IS NULL AND u.current_sign_in_at >= ?1`,
    ).bind(activeMonthSince).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT a.id) AS cnt
       FROM accounts a
       JOIN users u ON u.account_id = a.id
       WHERE a.domain IS NULL AND u.current_sign_in_at >= ?1`,
    ).bind(activeHalfyearSince).first(),
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM statuses WHERE deleted_at IS NULL`).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM statuses WHERE deleted_at IS NULL AND local = 1 AND reply = 1`).first(),
  ]);

  const stats: NodeInfoStats = {
    activeUserCount: (usersResult?.cnt as number) ?? 0,
    activeMonthUserCount: (activeMonthUserCountResult?.cnt as number) ?? 0,
    activeHalfyearUserCount: (activeHalfyearUserCountResult?.cnt as number) ?? 0,
    statusCount: (statusesResult?.cnt as number) ?? 0,
    domainCount: (domainsResult?.cnt as number) ?? 0,
    localComments: (commentsResult?.cnt as number) ?? 0,
  };

  await env.CACHE.put(STATS_CACHE_KEY, JSON.stringify(stats), {
    expirationTtl: STATS_CACHE_TTL,
  });

  return stats;
}

/**
 * Register the NodeInfo dispatcher on the given Federation instance.
 */
export function setupNodeInfoDispatcher(fed: Federation<FedifyContextData>): void {
  fed.setNodeInfoDispatcher('/nodeinfo/2.1', async (): Promise<NodeInfo> => {
    const stats = await getStats();
    const registrationMode = await getSetting('registration_mode').catch(() => null)
      || env.REGISTRATION_MODE
      || 'closed';
    const registrationOpen = registrationMode === 'open' || registrationMode === 'approval';

    return {
      software: {
        name: 'siliconbeest',
        version: SILICONBEEST_VERSION,
        repository: new URL(getRepositoryUrl()),
        homepage: new URL(`https://${env.INSTANCE_DOMAIN}`),
      },
      protocols: ['activitypub'],
      openRegistrations: registrationOpen,
      usage: {
        users: {
          total: stats.activeUserCount,
          activeMonth: stats.activeMonthUserCount,
          activeHalfyear: stats.activeHalfyearUserCount,
        },
        localPosts: stats.statusCount,
        localComments: stats.localComments,
      },
      metadata: {
        nodeName: await getInstanceTitle(),
        nodeDescription: `A SiliconBeest instance at ${env.INSTANCE_DOMAIN}`,
      },
    };
  });
}
