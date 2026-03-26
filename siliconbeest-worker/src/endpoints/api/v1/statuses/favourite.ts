import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Like } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

const app = new Hono<HonoEnv>();

app.post('/:id/favourite', authRequired, async (c) => {
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

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateUlid();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO favourites (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(id, currentAccountId, statusId, now),
      c.env.DB.prepare('UPDATE statuses SET favourites_count = favourites_count + 1 WHERE id = ?1').bind(statusId),
    ]);

    // Create notification for the status author (don't notify yourself)
    const statusAuthorId = row.account_id as string;
    if (statusAuthorId !== currentAccountId) {
      try {
        await c.env.QUEUE_INTERNAL.send({
          type: 'create_notification',
          recipientAccountId: statusAuthorId,
          senderAccountId: currentAccountId,
          notificationType: 'favourite',
          statusId,
        });
      } catch (_) { /* don't fail the API response */ }
    }

    // Federation: deliver Like activity if the status author is remote
    if (row.account_domain) {
      try {
        const currentAccount = await c.env.DB.prepare(
          'SELECT uri, username FROM accounts WHERE id = ?1',
        ).bind(currentAccountId).first();
        if (currentAccount) {
          const actorUri = currentAccount.uri as string;
          const statusUri = row.uri as string;
          const authorUri = row.account_uri as string;
          const like = new Like({
            id: new URL(`https://${domain}/activities/${generateUlid()}`),
            actor: new URL(actorUri),
            object: new URL(statusUri),
          });
          const fed = c.get('federation');
          await sendToRecipient(fed, c.env, currentAccount.username as string, authorUri, like);
        }
      } catch (e) {
        console.error('Federation delivery failed for favourite:', e);
      }
    }
  }

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.favourited = true;
  if (!existing) {
    status.favourites_count += 1;
  }

  return c.json(status);
});

export default app;
