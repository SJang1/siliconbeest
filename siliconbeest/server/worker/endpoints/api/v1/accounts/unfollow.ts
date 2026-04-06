import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Follow, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { removeFollow, getRelationship } from '../../../../services/account';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfollow', authRequired, requireScope('write:follows'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const target = await env.DB.prepare('SELECT id, username, domain, uri, inbox_url, shared_inbox_url FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  const currentAccount = await env.DB.prepare('SELECT id, username, uri FROM accounts WHERE id = ?1').bind(currentAccountId).first();
  const actorUri = currentAccount?.uri as string || `https://${domain}/users/${currentAccount?.username}`;
  const targetUri = target.uri as string;

  const result = await removeFollow(currentAccountId, targetId);

  // Send Undo(Follow) to remote server for deleted follow
  if (result.deletedFollow && target.domain) {
    const originalFollow = new Follow({
      id: new URL(result.deletedFollow.uri || `https://${domain}/activities/${generateUlid()}`),
      actor: new URL(actorUri),
      object: new URL(targetUri),
    });
    const undo = new Undo({
      id: new URL(`https://${domain}/activities/${generateUlid()}`),
      actor: new URL(actorUri),
      object: originalFollow,
    });
    const fed = c.get('federation');
    await sendToRecipient(fed, currentAccount?.username as string, targetUri, undo);
  }

  // Send Undo(Follow) for pending request too
  if (result.deletedFollowRequest && target.domain) {
    const frFollow = new Follow({
      id: new URL(result.deletedFollowRequest.uri || `https://${domain}/activities/${generateUlid()}`),
      actor: new URL(actorUri),
      object: new URL(targetUri),
    });
    const undo = new Undo({
      id: new URL(`https://${domain}/activities/${generateUlid()}`),
      actor: new URL(actorUri),
      object: frFollow,
    });
    const fed = c.get('federation');
    await sendToRecipient(fed, currentAccount?.username as string, targetUri, undo);
  }

  return c.json(await getRelationship(currentAccountId, targetId));
});

export default app;
