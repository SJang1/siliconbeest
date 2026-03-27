import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { serializeMarker } from '../../../utils/mastodonSerializer';
import type { MarkerRow } from '../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/v1/markers — reading position markers
app.get('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;

  const timelines = c.req.queries('timeline[]') ?? ['home', 'notifications'];

  const placeholders = timelines.map(() => '?').join(', ');
  const { results } = await c.env.DB.prepare(`
    SELECT * FROM markers
    WHERE user_id = ?1 AND timeline IN (${placeholders})
  `).bind(user.id, ...timelines).all();

  const markers: Record<string, any> = {};
  for (const row of results ?? []) {
    const r = row as unknown as MarkerRow;
    markers[r.timeline] = serializeMarker(r);
  }

  return c.json(markers);
});

// POST /api/v1/markers — update markers
app.post('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;
  const body = await c.req.json<Record<string, { last_read_id: string }>>();

  const markers: Record<string, any> = {};
  const now = new Date().toISOString();

  for (const timeline of ['home', 'notifications']) {
    const data = body[timeline];
    if (!data?.last_read_id) continue;

    // Upsert: increment version or insert with version 0
    const existing = await c.env.DB.prepare(
      `SELECT id, version FROM markers WHERE user_id = ?1 AND timeline = ?2 LIMIT 1`,
    ).bind(user.id, timeline).first<{ id: string; version: number }>();

    if (existing) {
      const newVersion = existing.version + 1;
      await c.env.DB.prepare(`
        UPDATE markers SET last_read_id = ?1, version = ?2, updated_at = ?3
        WHERE id = ?4
      `).bind(data.last_read_id, newVersion, now, existing.id).run();

      markers[timeline] = {
        last_read_id: data.last_read_id,
        version: newVersion,
        updated_at: now,
      };
    } else {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO markers (id, user_id, timeline, last_read_id, version, updated_at)
        VALUES (?1, ?2, ?3, ?4, 0, ?5)
      `).bind(id, user.id, timeline, data.last_read_id, now).run();

      markers[timeline] = {
        last_read_id: data.last_read_id,
        version: 0,
        updated_at: now,
      };
    }
  }

  return c.json(markers);
});

export default app;
