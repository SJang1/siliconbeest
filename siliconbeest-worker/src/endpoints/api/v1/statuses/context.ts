import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatus } from './fetch';
import { enrichStatuses } from '../../../../utils/statusEnrichment';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/:id/context', authOptional, async (c) => {
  const statusId = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  // Verify status exists
  const status = await c.env.DB.prepare(
    'SELECT id, in_reply_to_id, conversation_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(statusId).first();
  if (!status) throw new AppError(404, 'Record not found');

  // Ancestors: walk up the in_reply_to chain
  const ancestors: Record<string, unknown>[] = [];
  let currentId = status.in_reply_to_id as string | null;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId) && ancestors.length < 40) {
    visited.add(currentId);
    const ancestor = await c.env.DB.prepare(
      `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
    ).bind(currentId).first();
    if (!ancestor) break;
    ancestors.unshift(ancestor as Record<string, unknown>);
    currentId = (ancestor.in_reply_to_id as string) || null;
  }

  // Descendants: get all replies in this conversation after this status
  const { results: descendantRows } = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL}
     WHERE s.conversation_id = ?1
       AND s.id > ?2
       AND s.deleted_at IS NULL
     ORDER BY s.id ASC
     LIMIT 60`,
  ).bind(status.conversation_id as string, statusId).all();

  const currentAccountId = c.get('currentUser')?.account_id ?? null;

  // Collect all status IDs for batch enrichment
  const allRows = [...ancestors, ...(descendantRows as Record<string, unknown>[])];
  const allIds = allRows.map((r) => r.id as string);
  const enrichments = await enrichStatuses(c.env.DB, domain, allIds, currentAccountId);

  function enrichAndSerialize(r: Record<string, unknown>) {
    const s = serializeStatus(r, domain);
    const e = enrichments.get(r.id as string);
    if (e) {
      s.media_attachments = e.mediaAttachments as any[];
      s.favourited = e.favourited ?? false;
      s.reblogged = e.reblogged ?? false;
      s.bookmarked = e.bookmarked ?? false;
      s.card = e.card ?? null;
      s.emojis = e.emojis ?? [];
    }
    return s;
  }

  return c.json({
    ancestors: ancestors.map(enrichAndSerialize),
    descendants: (descendantRows as Record<string, unknown>[]).map(enrichAndSerialize),
  });
});

export default app;
