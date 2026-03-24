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

  // Descendants: find all replies via conversation_id OR in_reply_to chain
  // Use both approaches to handle cases where conversation_id is null (remote statuses)
  const descendantRows: Record<string, unknown>[] = [];
  const seenDescendantIds = new Set<string>();

  // Method 1: conversation_id based (fast, catches most cases)
  if (status.conversation_id) {
    const { results: convRows } = await c.env.DB.prepare(
      `${STATUS_JOIN_SQL}
       WHERE s.conversation_id = ?1
         AND s.id != ?2
         AND s.deleted_at IS NULL
       ORDER BY s.created_at ASC
       LIMIT 60`,
    ).bind(status.conversation_id as string, statusId).all();
    for (const r of (convRows ?? []) as Record<string, unknown>[]) {
      if (!seenDescendantIds.has(r.id as string)) {
        seenDescendantIds.add(r.id as string);
        descendantRows.push(r);
      }
    }
  }

  // Method 2: in_reply_to_id based (catches replies to statuses with null conversation_id)
  // BFS: find direct replies, then replies to those, etc.
  const queue = [statusId];
  let depth = 0;
  while (queue.length > 0 && depth < 10 && descendantRows.length < 60) {
    const batch = queue.splice(0, queue.length);
    const ph = batch.map(() => '?').join(',');
    const { results: replyRows } = await c.env.DB.prepare(
      `${STATUS_JOIN_SQL}
       WHERE s.in_reply_to_id IN (${ph})
         AND s.deleted_at IS NULL
       ORDER BY s.created_at ASC
       LIMIT 60`,
    ).bind(...batch).all();
    for (const r of (replyRows ?? []) as Record<string, unknown>[]) {
      const rid = r.id as string;
      if (!seenDescendantIds.has(rid)) {
        seenDescendantIds.add(rid);
        descendantRows.push(r);
        queue.push(rid);
      }
    }
    depth++;
  }

  // Filter: only show descendants (created after the target status or explicitly replying to it)
  // and sort by created_at
  descendantRows.sort((a, b) =>
    (a.created_at as string) < (b.created_at as string) ? -1 : 1
  );

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
