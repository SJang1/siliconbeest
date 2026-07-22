import { Hono } from 'hono';
import { Temporal } from '@js-temporal/polyfill';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { sendToRecipients } from '../../../../federation/helpers/send';
import { getStatusFederationAudience } from '../../../../federation/helpers/status-audience';
import { Delete as APDelete, Tombstone } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';
import { deleteStatus } from '../../../../services/status';
import { sendStreamEventToDurableObject } from '../../../../services/streaming';
import { canBroadcastStatusToPublicStreams } from '../../../../../../../packages/shared/permissions';
import {
  removeRecommendationActivitiesForStatus,
  removeRecommendationActivity,
} from '../../../../services/recommendationActivity';
import { scheduleBackgroundTask } from '../../../../utils/backgroundTask';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.delete('/:id', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const { status: row } = await deleteStatus(statusId, currentAccountId);
  const cleanupTask = row.reblog_of_id
    ? removeRecommendationActivity(currentAccountId, 'reposted', row.reblog_of_id)
    : removeRecommendationActivitiesForStatus(statusId);
  await scheduleBackgroundTask(
    () => c.executionCtx,
    cleanupTask,
    {
      operation: 'remove_recommendation_activity',
      activityKind: row.reblog_of_id ? 'reposted' : 'status_deleted',
      accountId: currentAccountId,
      statusId: row.reblog_of_id ?? statusId,
    },
  );

  // Federation: deliver Delete(Note) to followers if status is local
  if (row.local === 1) {
    try {
      const account = await env.DB_META_C000.prepare(
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
        const audience = await getStatusFederationAudience({
          id: row.id,
          accountId: row.account_id,
          visibility: row.visibility,
          local: row.local,
          accountDomain: null,
          inReplyToAccountId: row.in_reply_to_account_id,
        });
        await sendToRecipients(fed, account.username as string, audience.recipients, del);
      }
    } catch (e) {
      console.error('Federation delivery failed for status delete:', e);
    }
  }

  // Broadcast delete event via streaming to all connected clients
  try {
    const author = await env.DB_META_C000.prepare(
      'SELECT suspended_at, silenced_at FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(currentAccountId).first<{
      suspended_at: string | null;
      silenced_at: string | null;
    }>();
    if (canBroadcastStatusToPublicStreams({
      visibility: row.visibility,
      statusDeleted: false,
      authorSuspended: author ? author.suspended_at !== null : null,
      authorSilenced: author ? author.silenced_at !== null : null,
    })) {
      await sendStreamEventToDurableObject('__public__', {
        event: 'delete',
        payload: statusId,
        stream: ['public', 'public:local'],
      });
    }

    // Send to the author's user stream
    const user = c.get('currentUser')!;
    await sendStreamEventToDurableObject(user.id, {
      event: 'delete',
      payload: statusId,
      stream: ['user'],
    });
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
