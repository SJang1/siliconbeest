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

  // Verify status exists and check visibility
  const status = await c.env.DB.prepare(
    'SELECT id, in_reply_to_id, conversation_id, visibility, account_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(statusId).first();
  if (!status) throw new AppError(404, 'Record not found');

  const currentAccountId = c.get('currentUser')?.account_id ?? null;
  const visibility = status.visibility as string;
  const statusAccountId = status.account_id as string;

  if (visibility === 'direct') {
    if (!currentAccountId) throw new AppError(404, 'Record not found');
    if (currentAccountId !== statusAccountId) {
      const mention = await c.env.DB.prepare(
        'SELECT 1 FROM mentions WHERE status_id = ?1 AND account_id = ?2 LIMIT 1',
      ).bind(statusId, currentAccountId).first();
      if (!mention) throw new AppError(404, 'Record not found');
    }
  } else if (visibility === 'private') {
    if (!currentAccountId) throw new AppError(404, 'Record not found');
    if (currentAccountId !== statusAccountId) {
      const follow = await c.env.DB.prepare(
        'SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2 LIMIT 1',
      ).bind(currentAccountId, statusAccountId).first();
      if (!follow) throw new AppError(404, 'Record not found');
    }
  }

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

  // Build set of ancestor IDs + current status to exclude from descendants
  const excludeIds = new Set<string>([statusId, ...ancestors.map((a) => a.id as string)]);

  // Descendants: find all replies via BFS from current status
  const descendantRows: Record<string, unknown>[] = [];
  const seenDescendantIds = new Set<string>();

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
      if (!seenDescendantIds.has(rid) && !excludeIds.has(rid)) {
        seenDescendantIds.add(rid);
        descendantRows.push(r);
        queue.push(rid);
      }
    }
    depth++;
  }

  // Collect all status IDs for batch enrichment
  const allRows = [...ancestors, ...(descendantRows as Record<string, unknown>[])];
  const allIds = allRows.map((r) => r.id as string);
  const enrichments = await enrichStatuses(c.env.DB, domain, allIds, currentAccountId, c.env.CACHE);

  function enrichAndSerialize(r: Record<string, unknown>) {
    const e = enrichments.get(r.id as string);
    const s = serializeStatus(r, domain, undefined, e?.accountEmojis);
    if (e) {
      s.media_attachments = e.mediaAttachments ?? [];
      s.favourited = e.favourited ?? false;
      s.reblogged = e.reblogged ?? false;
      s.bookmarked = e.bookmarked ?? false;
      s.card = e.card ?? null;
      s.poll = e.poll ?? null;
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
