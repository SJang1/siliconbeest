import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToRecipient, sendToFollowers } from '../../../../federation/helpers/send';
import { Like } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { favouriteStatus } from '../../../../services/status';

const app = new Hono<HonoEnv>();

app.post('/:id/favourite', authRequired, requireScope('write:favourites'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const { created } = await favouriteStatus(currentAccountId, statusId);

  if (created) {
    // Create notification for the status author (don't notify yourself)
    const statusAuthorId = row.account_id as string;
    if (statusAuthorId !== currentAccountId) {
      await env.QUEUE_INTERNAL.send({
        type: 'create_notification',
        recipientAccountId: statusAuthorId,
        senderAccountId: currentAccountId,
        notificationType: 'favourite',
        statusId,
      });
    }

    // Federation: deliver Like activity
    try {
      const currentAccount = await env.DB.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const statusUri = row.uri as string;
        const like = new Like({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(statusUri),
        });
        const fed = c.get('federation');
        // If author is remote, send directly to their inbox
        if (row.account_domain) {
          const authorUri = row.account_uri as string;
          await sendToRecipient(fed, currentAccount.username as string, authorUri, like);
        }
        // Always fan out to followers
        await sendToFollowers(fed, currentAccount.username as string, like);
      }
    } catch (e) {
      throw new Error(`Federation delivery failed for favourite: ${e instanceof Error ? e.message : e}`);
    }
  }

  const status = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentAccountId, env.CACHE);
  status.favourited = true;
  if (created) {
    status.favourites_count += 1;
  }

  return c.json(status);
});

export default app;
