import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToFollowers } from '../../../../federation/helpers/send';
import { Announce } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

const app = new Hono<HonoEnv>();

app.post('/:id/reblog', authRequired, async (c) => {
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

  // Check if already reblogged
  const existing = await c.env.DB.prepare(
    'SELECT id FROM statuses WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL',
  ).bind(statusId, currentUser.account_id).first();

  if (existing) {
    // Return the existing reblog
    const rebloggedStatus = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentUser.account_id, c.env.CACHE);
    rebloggedStatus.reblogged = true;
    return c.json({
      id: existing.id as string,
      created_at: new Date().toISOString(),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      spoiler_text: '',
      visibility,
      language: null,
      uri: `https://${domain}/users/${currentAccount.username}/statuses/${existing.id}`,
      url: `https://${domain}/@${currentAccount.username}/${existing.id}`,
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
  const reblogId = generateUlid();
  const reblogUri = `https://${domain}/users/${currentAccount.username}/statuses/${reblogId}/activity`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, reblog_of_id, visibility, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
    ).bind(reblogId, reblogUri, null, currentUser.account_id, statusId, visibility, now),
    c.env.DB.prepare('UPDATE statuses SET reblogs_count = reblogs_count + 1 WHERE id = ?1').bind(statusId),
    c.env.DB.prepare('UPDATE accounts SET statuses_count = statuses_count + 1 WHERE id = ?1').bind(currentUser.account_id),
  ]);

  // Add reblog to own home timeline immediately
  try {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO home_timeline_entries (status_id, account_id, created_at) VALUES (?1, ?2, ?3)',
    ).bind(reblogId, currentUser.account_id, now).run();
  } catch (_) { /* ignore */ }

  // Fanout reblog to followers' home timelines
  try {
    await c.env.QUEUE_INTERNAL.send({
      type: 'timeline_fanout',
      statusId: reblogId,
      accountId: currentUser.account_id,
    });
  } catch (_) { /* don't fail */ }

  // Create notification for the status author (don't notify yourself)
  const statusAuthorId = row.account_id as string;
  if (statusAuthorId !== currentUser.account_id) {
    try {
      await c.env.QUEUE_INTERNAL.send({
        type: 'create_notification',
        recipientAccountId: statusAuthorId,
        senderAccountId: currentUser.account_id,
        notificationType: 'reblog',
        statusId,
      });
    } catch (_) { /* don't fail the API response */ }
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
    console.error('Federation delivery failed for reblog:', e);
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
