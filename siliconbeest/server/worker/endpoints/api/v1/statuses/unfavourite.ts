import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToRecipient, sendToFollowers } from '../../../../federation/helpers/send';
import { Like, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { unfavouriteStatus } from '../../../../services/status';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfavourite', authRequired, requireScope('write:favourites'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  // Check if favourite exists before unfavouriting (for federation decision)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2',
  ).bind(currentAccountId, statusId).first();

  await unfavouriteStatus(c.env.DB, currentAccountId, statusId);

  // Federation: deliver Undo(Like)
  if (existing) {
    try {
      const currentAccount = await c.env.DB.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const statusUri = row.uri as string;
        const originalLike = new Like({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(statusUri),
        });
        const undo = new Undo({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: originalLike,
        });
        const fed = c.get('federation');
        // If author is remote, send directly to their inbox
        if (row.account_domain) {
          const authorUri = row.account_uri as string;
          await sendToRecipient(fed, c.env, currentAccount.username as string, authorUri, undo);
        }
        // Always fan out to followers
        await sendToFollowers(fed, c.env, currentAccount.username as string, undo);
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
