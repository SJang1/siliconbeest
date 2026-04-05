import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Block, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { removeBlock, getRelationship } from '../../../../services/account';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unblock', authRequired, requireScope('write:blocks'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const db = c.env.DB;

  const target = await db.prepare('SELECT id, domain, uri FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  await removeBlock(db, currentAccountId, targetId);

  // Federation: deliver Undo(Block) if target is remote
  if (target.domain) {
    try {
      const currentAccount = await db.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const targetUri = target.uri as string;
        const domain = c.env.INSTANCE_DOMAIN;
        const originalBlock = new Block({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(targetUri),
        });
        const undo = new Undo({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: originalBlock,
        });
        const fed = c.get('federation');
        await sendToRecipient(fed, c.env, currentAccount.username as string, targetUri, undo);
      }
    } catch (e) {
      console.error('Federation delivery failed for unblock:', e);
    }
  }

  return c.json(await getRelationship(db, currentAccountId, targetId));
});

export default app;
