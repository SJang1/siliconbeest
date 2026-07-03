/**
 * Airport Map API
 *
 * GET / — Aggregate activity for the public /airport visualization page.
 * No authentication required.
 *
 * Returns only aggregate counts over the last 24 hours plus remote domain
 * names (domains are already public via GET /api/v1/instance/peers).
 * No account names, status content, or any other PII.
 *
 * Load profile: the response is cached in KV for 60 seconds and served with
 * a short edge Cache-Control, so D1 is queried at most about once per minute
 * globally regardless of how many viewers poll the page.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../types';
import { ulidLowerBound } from '../../utils/ulid';

const app = new Hono<{ Variables: AppVariables }>();

const CACHE_KEY = 'airport:stats:v4';
const CACHE_TTL = 60; // seconds
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DESTINATIONS = 8;
const MAX_ROUTES = 12;

export interface AirportStats {
	window: '24h';
	generatedAt: string;
	flights: {
		departures: number; // local statuses created in window
		arrivals: number; // remote statuses received in window
		transfers: number; // local reblogs (Announce re-federation) in window
	};
	cargo: {
		outCount: number; // locally uploaded media attachments in window
		outBytes: number;
		inCount: number; // remote media attachments in window
		inBytes: number;
	};
	passport: {
		registrations: number; // new local users in window
	};
	dlq: {
		/**
		 * Deliveries that exhausted every retry and were parked in
		 * federation_dlq_parked (a backlog, not a 24h flow). 0 is good news.
		 */
		parked: number;
	};
	destinations: Array<{
		domain: string;
		arrivals: number;
		delayed: boolean;
	}>;
	delayedRoutes: Array<{
		domain: string;
		failureCount: number;
		lastFailedAt: string | null;
	}>;
}

interface CountRow {
	cnt: number;
}

interface CargoRow {
	cnt: number;
	bytes: number;
}

interface OriginRow {
	domain: string;
	cnt: number;
}

interface RouteRow {
	domain: string;
	last_successful_at: string | null;
	last_failed_at: string | null;
	failure_count: number;
}

async function computeStats(): Promise<AirportStats> {
	const now = new Date();
	const cutoffMs = now.getTime() - WINDOW_MS;
	const cutoffIso = new Date(cutoffMs).toISOString();
	// media_attachments has no created_at index; its ULID primary key is
	// time-ordered, so a PK range scan replaces the missing index.
	const mediaLowerBound = ulidLowerBound(cutoffMs);

	const [
		departuresRow,
		arrivalsRow,
		transfersRow,
		registrationsRow,
		cargoOutRow,
		cargoInRow,
		originRows,
		routeRows,
		dlqRow,
	] = await Promise.all([
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM statuses
			 WHERE local = 1 AND deleted_at IS NULL AND created_at >= ?1`,
		)
			.bind(cutoffIso)
			.first<CountRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM statuses
			 WHERE local = 0 AND deleted_at IS NULL AND created_at >= ?1`,
		)
			.bind(cutoffIso)
			.first<CountRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM statuses
			 WHERE local = 1 AND reblog_of_id IS NOT NULL
			 AND deleted_at IS NULL AND created_at >= ?1`,
		)
			.bind(cutoffIso)
			.first<CountRow>(),
		env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE created_at >= ?1`)
			.bind(cutoffIso)
			.first<CountRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS bytes
			 FROM media_attachments
			 WHERE id >= ?1 AND remote_url IS NULL`,
		)
			.bind(mediaLowerBound)
			.first<CargoRow>(),
		// Remote attachments carry no file_size (they are never stored here);
		// real sizes come from the media-proxy ledger, which records the
		// actual bytes fetched from origin. Attachments nobody has fetched
		// yet contribute 0 — the number only says what we truly measured.
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt, COALESCE(SUM(mpc.size), 0) AS bytes
			 FROM media_attachments ma
			 LEFT JOIN media_proxy_cache mpc ON mpc.remote_url = ma.remote_url
			 WHERE ma.id >= ?1 AND ma.remote_url IS NOT NULL`,
		)
			.bind(mediaLowerBound)
			.first<CargoRow>(),
		env.DB.prepare(
			`SELECT a.domain AS domain, COUNT(*) AS cnt
			 FROM statuses s
			 JOIN accounts a ON a.id = s.account_id
			 WHERE s.local = 0 AND s.deleted_at IS NULL AND s.created_at >= ?1
			 AND a.domain IS NOT NULL
			 AND NOT EXISTS (
			   SELECT 1 FROM domain_blocks db
			   WHERE db.domain = a.domain AND db.severity = 'suspend'
			 )
			 GROUP BY a.domain
			 ORDER BY cnt DESC
			 LIMIT ?2`,
		)
			.bind(cutoffIso, MAX_DESTINATIONS)
			.all<OriginRow>(),
		env.DB.prepare(
			`SELECT i.domain AS domain, i.last_successful_at, i.last_failed_at, i.failure_count
			 FROM instances i
			 WHERE (i.last_successful_at IS NOT NULL OR i.failure_count > 0)
			 AND NOT EXISTS (
			   SELECT 1 FROM domain_blocks db
			   WHERE db.domain = i.domain AND db.severity = 'suspend'
			 )
			 ORDER BY COALESCE(i.last_successful_at, '') DESC
			 LIMIT ?1`,
		)
			.bind(MAX_ROUTES)
			.all<RouteRow>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM federation_dlq_parked WHERE status = 'parked'`,
		).first<CountRow>(),
	]);

	const routes = routeRows?.results ?? [];
	const delayedDomains = new Set(
		routes.filter((r) => (r.failure_count ?? 0) > 0).map((r) => r.domain),
	);

	return {
		window: '24h',
		generatedAt: now.toISOString(),
		flights: {
			departures: departuresRow?.cnt ?? 0,
			arrivals: arrivalsRow?.cnt ?? 0,
			transfers: transfersRow?.cnt ?? 0,
		},
		cargo: {
			outCount: cargoOutRow?.cnt ?? 0,
			outBytes: cargoOutRow?.bytes ?? 0,
			inCount: cargoInRow?.cnt ?? 0,
			inBytes: cargoInRow?.bytes ?? 0,
		},
		passport: {
			registrations: registrationsRow?.cnt ?? 0,
		},
		dlq: {
			parked: dlqRow?.cnt ?? 0,
		},
		destinations: (originRows?.results ?? []).map((row) => ({
			domain: row.domain,
			arrivals: row.cnt,
			delayed: delayedDomains.has(row.domain),
		})),
		delayedRoutes: routes
			.filter((r) => (r.failure_count ?? 0) > 0)
			.map((r) => ({
				domain: r.domain,
				failureCount: r.failure_count,
				lastFailedAt: r.last_failed_at,
			})),
	};
}

// GET /api/airport
app.get('/', async (c) => {
	let stats = (await env.CACHE.get(CACHE_KEY, 'json')) as AirportStats | null;

	if (!stats) {
		stats = await computeStats();
		await env.CACHE.put(CACHE_KEY, JSON.stringify(stats), {
			expirationTtl: CACHE_TTL,
		});
	}

	return c.json(stats, 200, {
		'Cache-Control': 'public, max-age=30',
	});
});

export default app;
