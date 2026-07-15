import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { sendToFollowers, sendToRecipients } from '../../../../federation/helpers/send';
import { getStatusFederationAudience } from '../../../../federation/helpers/status-audience';
import { Announce } from '@fedify/fedify/vocab';
import { reblogStatus } from '../../../../services/status';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import { assertStatusRebloggable } from '../../../../services/permissions';

const app = new Hono<HonoEnv>();

app.post('/:id/reblog', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const currentAccountFull = await env.DB.prepare(
    'SELECT * FROM accounts WHERE id = ?1',
  ).bind(currentUser.account_id).first<Record<string, unknown>>();
  if (!currentAccountFull) throw new AppError(404, 'Account not found');

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');
  await assertStatusRebloggable(statusId, currentUser.account_id);

  const visibility = row.visibility as string;

  const { reblogId, reblogUri, created } = await reblogStatus(
    domain,
    currentUser.account_id,
    currentAccount.username,
    statusId,
  );
  c.set('contributionApplied', created);

  if (!created) {
    // Return the existing reblog
    const rebloggedStatus = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentUser.account_id, env.CACHE);
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
        display_name: (currentAccountFull.display_name as string) || '',
        locked: !!currentAccountFull.locked,
        bot: !!currentAccountFull.bot,
        discoverable: currentAccountFull.discoverable == null ? null : !!currentAccountFull.discoverable,
        group: false,
        created_at: (currentAccountFull.created_at as string) || '',
        note: (currentAccountFull.note as string) || '',
        url: `https://${domain}/@${currentAccount.username}`,
        uri: `https://${domain}/users/${currentAccount.username}`,
        avatar: (currentAccountFull.avatar_url as string) || '',
        avatar_static: (currentAccountFull.avatar_static_url as string) || (currentAccountFull.avatar_url as string) || '',
        header: (currentAccountFull.header_url as string) || '',
        header_static: (currentAccountFull.header_static_url as string) || (currentAccountFull.header_url as string) || '',
        followers_count: (currentAccountFull.followers_count as number) || 0,
        following_count: (currentAccountFull.following_count as number) || 0,
        statuses_count: (currentAccountFull.statuses_count as number) || 0,
        last_status_at: (currentAccountFull.last_status_at as string) || null,
        emojis: parseCustomEmojiTagsJson(currentAccountFull.emoji_tags as string | null, domain),
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
  await env.QUEUE_INTERNAL.send({
    type: 'timeline_fanout',
    statusId: reblogId,
    accountId: currentUser.account_id,
  });

  // Create notification for the status author (don't notify yourself)
  const statusAuthorId = row.account_id as string;
  if (statusAuthorId !== currentUser.account_id) {
    await env.QUEUE_INTERNAL.send({
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
    if (row.account_domain) {
      await sendToFollowers(fed, currentAccount.username, announce);
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
        { includeActorFollowersAccountId: currentUser.account_id },
      );
      await sendToRecipients(fed, currentAccount.username, audience.recipients, announce);
    }
  } catch (e) {
    throw new Error(`Federation delivery failed for reblog: ${e instanceof Error ? e.message : e}`);
  }

  const rebloggedStatus = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentUser.account_id, env.CACHE);
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
      display_name: (currentAccountFull.display_name as string) || '',
      locked: !!currentAccountFull.locked,
      bot: !!currentAccountFull.bot,
      discoverable: currentAccountFull.discoverable == null ? null : !!currentAccountFull.discoverable,
      group: false,
      created_at: now,
      note: (currentAccountFull.note as string) || '',
      url: `https://${domain}/@${currentAccount.username}`,
      uri: `https://${domain}/users/${currentAccount.username}`,
      avatar: (currentAccountFull.avatar_url as string) || '',
      avatar_static: (currentAccountFull.avatar_static_url as string) || (currentAccountFull.avatar_url as string) || '',
      header: (currentAccountFull.header_url as string) || '',
      header_static: (currentAccountFull.header_static_url as string) || (currentAccountFull.header_url as string) || '',
      followers_count: (currentAccountFull.followers_count as number) || 0,
      following_count: (currentAccountFull.following_count as number) || 0,
      statuses_count: (currentAccountFull.statuses_count as number) || 0,
      last_status_at: (currentAccountFull.last_status_at as string) || null,
      emojis: parseCustomEmojiTagsJson(currentAccountFull.emoji_tags as string | null, domain),
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
