import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToFollowers } from '../../../../federation/helpers/send';
import { Announce } from '@fedify/fedify/vocab';
import { reblogStatus } from '../../../../services/status';

const app = new Hono<HonoEnv>();

app.post('/:id/reblog', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  // Check visibility allows reblog
  const visibility = row.visibility as string;
  if (visibility === 'private' || visibility === 'direct') {
    throw new AppError(422, 'Validation failed', 'Cannot reblog this status');
  }

  const { reblogId, reblogUri, created } = await reblogStatus(
    c.env.DB,
    domain,
    currentUser.account_id,
    currentAccount.username,
    statusId,
  );

  if (!created) {
    // Return the existing reblog
    const rebloggedStatus = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentUser.account_id, c.env.CACHE);
    rebloggedStatus.reblogged = true;
    return c.json({
      id: reblogId,
      created_at: new Date().toISOString(),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      spoiler_text: '',
      visibility,
      language: null,
      uri: reblogUri,
      url: `https://${domain}/@${currentAccount.username}/${reblogId}`,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      favourited: false,
      reblogged: true,
      muted: false,
      bookmarked: false,
      pinned: false,
      content: '',
      reblog: rebloggedStatus,
      application: null,
      account: {
        id: currentUser.account_id,
        username: currentAccount.username,
        acct: currentAccount.username,
        display_name: '',
        locked: false,
        bot: false,
        discoverable: true,
        group: false,
        created_at: '',
        note: '',
        url: `https://${domain}/@${currentAccount.username}`,
        uri: `https://${domain}/users/${currentAccount.username}`,
        avatar: '',
        avatar_static: '',
        header: '',
        header_static: '',
        followers_count: 0,
        following_count: 0,
        statuses_count: 0,
        last_status_at: null,
        emojis: [],
        fields: [],
      },
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
      edited_at: null,
    });
  }

  const now = new Date().toISOString();

  // Fanout reblog to followers' home timelines
  await c.env.QUEUE_INTERNAL.send({
    type: 'timeline_fanout',
    statusId: reblogId,
    accountId: currentUser.account_id,
  });

  // Create notification for the status author (don't notify yourself)
  const statusAuthorId = row.account_id as string;
  if (statusAuthorId !== currentUser.account_id) {
    await c.env.QUEUE_INTERNAL.send({
      type: 'create_notification',
      recipientAccountId: statusAuthorId,
      senderAccountId: currentUser.account_id,
      notificationType: 'reblog',
      statusId,
    });
  }

  // Federation: deliver Announce activity to all followers
  try {
    const actorUri = `https://${domain}/users/${currentAccount.username}`;
    const followersUri = `${actorUri}/followers`;
    const statusUri = row.uri as string;
    const announce = new Announce({
      id: new URL(reblogUri),
      actor: new URL(actorUri),
      object: new URL(statusUri),
      published: Temporal.Now.instant(),
      tos: [new URL('https://www.w3.org/ns/activitystreams#Public')],
      ccs: [new URL(followersUri)],
    });
    const fed = c.get('federation');
    await sendToFollowers(fed, c.env, currentAccount.username, announce);
  } catch (e) {
    throw new Error(`Federation delivery failed for reblog: ${e instanceof Error ? e.message : e}`);
  }

  const rebloggedStatus = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentUser.account_id, c.env.CACHE);
  rebloggedStatus.reblogged = true;
  rebloggedStatus.reblogs_count += 1;

  return c.json({
    id: reblogId,
    created_at: now,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: false,
    spoiler_text: '',
    visibility,
    language: null,
    uri: reblogUri,
    url: null,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    favourited: false,
    reblogged: true,
    muted: false,
    bookmarked: false,
    pinned: false,
    content: '',
    reblog: rebloggedStatus,
    application: null,
    account: {
      id: currentUser.account_id,
      username: currentAccount.username,
      acct: currentAccount.username,
      display_name: '',
      locked: false,
      bot: false,
      discoverable: true,
      group: false,
      created_at: now,
      note: '',
      url: `https://${domain}/@${currentAccount.username}`,
      uri: `https://${domain}/users/${currentAccount.username}`,
      avatar: '',
      avatar_static: '',
      header: '',
      header_static: '',
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      last_status_at: null,
      emojis: [],
      fields: [],
    },
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    edited_at: null,
  });
});

export default app;
