import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToFollowers } from '../../../../federation/helpers/send';
import { Announce, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unreblog', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const reblog = await c.env.DB.prepare(
    'SELECT id FROM statuses WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL',
  ).bind(statusId, currentAccountId).first();

  if (reblog) {
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, reblog.id as string),
      c.env.DB.prepare('UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1').bind(statusId),
      c.env.DB.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(currentAccountId),
    ]);
  }

  // Federation: deliver Undo(Announce) to followers
  if (reblog) {
    try {
      const currentAccount = await c.env.DB.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const statusUri = row.uri as string;
        const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
        const followersUri = `${actorUri}/followers`;
        const originalAnnounce = new Announce({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
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
        await sendToFollowers(fed, c.env, currentAccount.username as string, undo);
      }
    } catch (e) {
      console.error('Federation delivery failed for unreblog:', e);
    }
  }

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.reblogged = false;
  if (reblog) {
    status.reblogs_count = Math.max(0, status.reblogs_count - 1);
  }

  return c.json(status);
});

export default app;
