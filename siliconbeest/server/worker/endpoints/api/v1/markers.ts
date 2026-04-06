import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { serializeMarker } from '../../../utils/mastodonSerializer';
import { getMarkers, upsertMarker } from '../../../services/marker';

const app = new Hono<{ Variables: AppVariables }>();

// GET /api/v1/markers — reading position markers
app.get('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;

  const timelines = c.req.queries('timeline[]') ?? ['home', 'notifications'];

  const results = await getMarkers(user.id, timelines);

  const markers: Record<string, any> = {};
  for (const r of results) {
    markers[r.timeline] = serializeMarker(r);
  }

  return c.json(markers);
});

// POST /api/v1/markers — update markers
app.post('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;
  const body = await c.req.json<Record<string, { last_read_id: string }>>();

  const markers: Record<string, any> = {};

  for (const timeline of ['home', 'notifications']) {
    const data = body[timeline];
    if (!data?.last_read_id) continue;

    markers[timeline] = await upsertMarker(user.id, timeline, data.last_read_id);
  }

  return c.json(markers);
});

export default app;
