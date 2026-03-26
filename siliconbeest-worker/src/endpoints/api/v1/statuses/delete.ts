import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { sendToFollowers } from '../../../../federation/helpers/send';
import { Delete as APDelete, Tombstone } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.delete('/:id', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    'SELECT * FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(statusId).first();

  if (!row) throw new AppError(404, 'Record not found');
  if (row.account_id !== currentAccountId) throw new AppError(403, 'This action is not allowed');

  const now = new Date().toISOString();

  const stmts = [
    c.env.DB.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, statusId),
    c.env.DB.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(currentAccountId),
  ];

  if (row.in_reply_to_id) {
    stmts.push(
      c.env.DB.prepare('UPDATE statuses SET replies_count = MAX(0, replies_count - 1) WHERE id = ?1').bind(row.in_reply_to_id as string),
    );
  }

  await c.env.DB.batch(stmts);

  // Federation: deliver Delete(Note) to followers if status is local
  if (row.local === 1) {
    try {
      const account = await c.env.DB.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (account) {
        const actorUri = account.uri as string;
        const del = new APDelete({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new Tombstone({ id: new URL(row.uri as string) }),
          published: Temporal.Now.instant(),
        });
        const fed = c.get('federation');
        await sendToFollowers(fed, c.env, account.username as string, del);
      }
    } catch (e) {
      console.error('Federation delivery failed for status delete:', e);
    }
  }

  // Broadcast delete event via streaming to all connected clients
  try {
    // Send to public streams
    const doId = c.env.STREAMING_DO.idFromName('__public__');
    const stub = c.env.STREAMING_DO.get(doId);
    await stub.fetch(new Request('http://internal/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'delete',
        payload: statusId,
        stream: ['public', 'public:local'],
      }),
    }));

    // Send to the author's user stream
    const user = c.get('currentUser')!;
    const userDoId = c.env.STREAMING_DO.idFromName(user.id);
    const userStub = c.env.STREAMING_DO.get(userDoId);
    await userStub.fetch(new Request('http://internal/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'delete',
        payload: statusId,
        stream: ['user'],
      }),
    }));
  } catch { /* non-critical */ }

  // Return the deleted status per Mastodon spec
  return c.json({
    id: row.id as string,
    created_at: row.created_at as string,
    in_reply_to_id: (row.in_reply_to_id as string) || null,
    in_reply_to_account_id: (row.in_reply_to_account_id as string) || null,
    sensitive: !!(row.sensitive),
    spoiler_text: (row.content_warning as string) || '',
    visibility: (row.visibility as string) || 'public',
    language: (row.language as string) || 'en',
    uri: row.uri as string,
    url: (row.url as string) || null,
    replies_count: (row.replies_count as number) || 0,
    reblogs_count: (row.reblogs_count as number) || 0,
    favourites_count: (row.favourites_count as number) || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    text: (row.text as string) || '',
    content: (row.content as string) || '',
    reblog: null,
    application: null,
    account: null,
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    edited_at: (row.edited_at as string) || null,
  });
});

export default app;
