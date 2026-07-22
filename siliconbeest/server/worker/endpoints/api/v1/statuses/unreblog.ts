import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToFollowers, sendToRecipients } from '../../../../federation/helpers/send';
import { getStatusFederationAudience } from '../../../../federation/helpers/status-audience';
import { Announce, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { unreblogStatus } from '../../../../services/status';
import { canViewStatusById } from '../../../../services/permissions';
import { removeRecommendationActivity } from '../../../../services/recommendationActivity';
import { scheduleBackgroundTask } from '../../../../utils/backgroundTask';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unreblog', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB_META_C000.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1`,
  ).bind(statusId).first();

  const canView = await canViewStatusById(statusId, currentAccountId);
  const { reblogId } = await unreblogStatus(currentAccountId, statusId);
  c.set('contributionApplied', reblogId !== null);
  if (reblogId) {
    await scheduleBackgroundTask(
      () => c.executionCtx,
      removeRecommendationActivity(currentAccountId, 'reposted', statusId),
      {
        operation: 'remove_recommendation_activity',
        activityKind: 'reposted',
        accountId: currentAccountId,
        statusId,
      },
    );
  }

  // Federation: deliver Undo(Announce) to followers
  if (reblogId && row) {
    try {
      const currentAccount = await env.DB_META_C000.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const username = currentAccount.username as string;
        const statusUri = row.uri as string;
        const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
        const followersUri = `${actorUri}/followers`;
        const originalAnnounce = new Announce({
          id: new URL(`https://${domain}/users/${username}/statuses/${reblogId}/activity`),
          actor: new URL(actorUri),
          object: new URL(statusUri),
          published: Temporal.Now.instant(),
          tos: [new URL(AS_PUBLIC)],
          ccs: [new URL(followersUri)],
        });
        const undo = new Undo({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: originalAnnounce,
        });
        const fed = c.get('federation');
        if (row.account_domain) {
          await sendToFollowers(fed, username, undo);
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
          await sendToRecipients(fed, username, audience.recipients, undo);
        }
      }
    } catch (e) {
      console.error('Federation delivery failed for unreblog:', e);
    }
  }

  if (!row || !canView) throw new AppError(404, 'Record not found');
  const status = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentAccountId, env.CACHE);
  status.reblogged = false;
  if (reblogId) {
    status.reblogs_count = Math.max(0, status.reblogs_count - 1);
  }

  return c.json(status);
});

export default app;
