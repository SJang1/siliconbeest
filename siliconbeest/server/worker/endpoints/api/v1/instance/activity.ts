/**
 * Instance Activity API
 *
 * GET / — Returns 12 weeks of instance activity statistics.
 * No authentication required.
 *
 * Each entry contains:
 *  - week: Unix epoch string of the Monday starting that week
 *  - statuses: number of local statuses created that week
 *  - logins: number of unique user logins that week
 *  - registrations: number of new user registrations that week
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/', async (c) => {
  const weeks: Array<{
    week: string;
    statuses: string;
    logins: string;
    registrations: string;
  }> = [];

  const now = new Date();
  // Find the most recent Monday at 00:00 UTC
  const dayOfWeek = now.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < 12; i++) {
    const weekStart = new Date(monday.getTime() - i * 7 * 86400000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

    const weekStartIso = weekStart.toISOString();
    const weekEndIso = weekEnd.toISOString();
    const weekEpoch = Math.floor(weekStart.getTime() / 1000).toString();

    const statusCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM statuses
       WHERE local = 1 AND deleted_at IS NULL
       AND created_at >= ?1 AND created_at < ?2`,
    )
      .bind(weekStartIso, weekEndIso)
      .first<{ cnt: number }>();

    const loginCount = await env.DB.prepare(
      `SELECT COUNT(DISTINCT id) AS cnt FROM users
       WHERE current_sign_in_at >= ?1 AND current_sign_in_at < ?2`,
    )
      .bind(weekStartIso, weekEndIso)
      .first<{ cnt: number }>();

    const registrationCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM users
       WHERE created_at >= ?1 AND created_at < ?2`,
    )
      .bind(weekStartIso, weekEndIso)
      .first<{ cnt: number }>();

    weeks.push({
      week: weekEpoch,
      statuses: String(statusCount?.cnt ?? 0),
      logins: String(loginCount?.cnt ?? 0),
      registrations: String(registrationCount?.cnt ?? 0),
    });
  }

  return c.json(weeks);
});

export default app;
