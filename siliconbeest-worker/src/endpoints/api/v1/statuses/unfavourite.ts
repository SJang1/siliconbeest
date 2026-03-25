import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { buildLikeActivity, buildUndoActivity } from '../../../../federation/activityBuilder';
import { enqueueDelivery } from '../../../../federation/deliveryManager';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfavourite', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2',
  ).bind(currentAccountId, statusId).first();

  if (existing) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM favourites WHERE id = ?1').bind(existing.id as string),
      c.env.DB.prepare('UPDATE statuses SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?1').bind(statusId),
    ]);
  }

  // Federation: deliver Undo(Like) if status author is remote
  if (existing && row.account_domain) {
    try {
      const currentAccount = await c.env.DB.prepare(
        'SELECT uri FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const statusUri = row.uri as string;
        const likeActivity = buildLikeActivity(actorUri, statusUri);
        const activity = buildUndoActivity(actorUri, likeActivity);
        const authorUri = row.account_uri as string;
        const authorInbox = `${authorUri}/inbox`;
        await enqueueDelivery(c.env.QUEUE_FEDERATION, JSON.stringify(activity), authorInbox, currentAccountId);
      }
    } catch (e) {
      console.error('Federation delivery failed for unfavourite:', e);
    }
  }

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.favourited = false;
  if (existing) {
    status.favourites_count = Math.max(0, status.favourites_count - 1);
  }

  return c.json(status);
});

export default app;
