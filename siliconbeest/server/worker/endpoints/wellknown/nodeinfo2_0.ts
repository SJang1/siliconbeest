/**
 * NodeInfo 2.0 — backward compatibility endpoint
 *
 * GET /nodeinfo/2.0
 *
 * Fedify handles /.well-known/nodeinfo and /nodeinfo/2.1.
 * This file provides the legacy /nodeinfo/2.0 response that some older
 * clients still request.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const STATS_CACHE_KEY = 'nodeinfo:stats:2.0';
const STATS_CACHE_TTL = 3600; // 1 hour

interface NodeInfoStats {
	userCount: number;
	statusCount: number;
	domainCount: number;
}

async function getStats(db: D1Database, cache: KVNamespace): Promise<NodeInfoStats> {
	const cached = await cache.get(STATS_CACHE_KEY, 'json');
	if (cached) return cached as NodeInfoStats;

	const [usersResult, statusesResult, domainsResult] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL`).first(),
		db.prepare(`SELECT COUNT(*) AS cnt FROM statuses WHERE deleted_at IS NULL`).first(),
		db.prepare(`SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL`).first(),
	]);

	const stats: NodeInfoStats = {
		userCount: (usersResult?.cnt as number) ?? 0,
		statusCount: (statusesResult?.cnt as number) ?? 0,
		domainCount: (domainsResult?.cnt as number) ?? 0,
	};

	await cache.put(STATS_CACHE_KEY, JSON.stringify(stats), {
		expirationTtl: STATS_CACHE_TTL,
	});

	return stats;
}

// GET /nodeinfo/2.0
app.get('/2.0', async (c) => {
	const stats = await getStats(c.env.DB, c.env.CACHE);
	const registrationOpen = c.env.REGISTRATION_MODE === 'open';

	return c.json(
		{
			version: '2.0',
			software: {
				name: 'siliconbeest',
				version: '0.1.0',
			},
			protocols: ['activitypub'],
			usage: {
				users: {
					total: stats.userCount,
					activeMonth: stats.userCount,
					activeHalfyear: stats.userCount,
				},
				localPosts: stats.statusCount,
			},
			openRegistrations: registrationOpen,
			services: {
				outbound: [],
				inbound: [],
			},
			metadata: {},
		},
		200,
		{
			'Content-Type': 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"',
			'Cache-Control': 'max-age=1800, public',
		},
	);
});

export default app;
