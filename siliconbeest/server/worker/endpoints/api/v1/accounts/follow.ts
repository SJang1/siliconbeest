import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Follow } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { createFollow, getRelationship } from '../../../../services/account';

const app = new Hono<HonoEnv>();

app.post('/:id/follow', authRequired, requireScope('write:follows'), async (c) => {
  const targetId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccountId = currentUser.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const target = await env.DB.prepare('SELECT id, username, domain, uri, inbox_url, shared_inbox_url, locked, manually_approves_followers FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  const result = await createFollow(domain, currentAccountId, {
    id: target.id as string,
    domain: target.domain as string | null,
    locked: target.locked as number,
    manually_approves_followers: target.manually_approves_followers as number,
  });

  // Existing follow or existing request — return current relationship
  if (result.uri === '') {
    return c.json(await getRelationship(currentAccountId, targetId));
  }

  // Federation & notifications for new follow requests
  if (result.type === 'follow_request') {
    const currentAccount = await env.DB.prepare('SELECT id, username, uri FROM accounts WHERE id = ?1').bind(currentAccountId).first();
    const actorUri = currentAccount?.uri as string || `https://${domain}/users/${currentAccount?.username}`;
    const targetUri = target.uri as string;
    const isRemote = !!(target.domain);

    const follow = new Follow({
      id: new URL(result.uri),
      actor: new URL(actorUri),
      object: new URL(targetUri),
    });

    if (isRemote) {
      const fed = c.get('federation');
      await sendToRecipient(fed, currentAccount?.username as string, targetUri, follow);
    } else {
      // Local locked account: create notification for target
      await env.QUEUE_INTERNAL.send({
        type: 'create_notification',
        recipientAccountId: targetId,
        senderAccountId: currentAccountId,
        notificationType: 'follow_request',
      });
    }
  } else {
    // Local auto-accept: send notification
    await env.QUEUE_INTERNAL.send({
      type: 'create_notification',
      recipientAccountId: targetId,
      senderAccountId: currentAccountId,
      notificationType: 'follow',
    });
  }

  return c.json(await getRelationship(currentAccountId, targetId));
});

export default app;
