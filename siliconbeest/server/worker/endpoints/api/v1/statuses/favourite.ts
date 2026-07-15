import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToRecipient, sendToFollowers, sendToRecipients } from '../../../../federation/helpers/send';
import { getStatusFederationAudience } from '../../../../federation/helpers/status-audience';
import { Like } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { favouriteStatus } from '../../../../services/status';
import { assertStatusInteractable } from '../../../../services/permissions';

const app = new Hono<HonoEnv>();

app.post('/:id/favourite', authRequired, requireScope('write:favourites'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');
  await assertStatusInteractable(statusId, currentAccountId);

  const { created } = await favouriteStatus(currentAccountId, statusId);
  c.set('contributionApplied', created);

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
          if (row.visibility === 'public' || row.visibility === 'unlisted') {
            await sendToFollowers(fed, currentAccount.username as string, like);
          }
        } else {
          const audience = await getStatusFederationAudience(
            {
              id: statusId,
              accountId: row.account_id as string,
              visibility: row.visibility as string,
              local: row.local as number | null,
              accountDomain: row.account_domain as string | null,
              inReplyToAccountId: row.in_reply_to_account_id as string | null,
            },
            { includeActorFollowersAccountId: currentAccountId },
          );
          await sendToRecipients(fed, currentAccount.username as string, audience.recipients, like);
        }
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
