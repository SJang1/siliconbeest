import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { serializeStatus } from './fetch';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import { getContext } from '../../../../services/status';

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

  const { ancestors, descendants } = await getContext(c.env.DB, statusId);

  // Collect all status IDs for batch enrichment
  const allRows = [...ancestors, ...descendants];
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
    descendants: descendants.map(enrichAndSerialize),
  });
});

export default app;
