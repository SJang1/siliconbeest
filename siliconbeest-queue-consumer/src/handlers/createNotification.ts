/**
 * Create Notification Handler
 *
 * Inserts a notification into the notifications table.
 * If the recipient has a web_push_subscription, enqueues
 * a send_web_push message for push delivery.
 */

import type { Env } from '../env';
import type { CreateNotificationMessage } from '../shared/types/queue';

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

export async function handleCreateNotification(
  msg: CreateNotificationMessage,
  env: Env,
): Promise<void> {
  const { recipientAccountId, senderAccountId, notificationType, statusId } = msg;

  // Don't notify yourself
  if (recipientAccountId === senderAccountId) {
    return;
  }

  // Check if the same notification already exists (idempotency)
  const existing = await env.DB.prepare(
    `SELECT id FROM notifications
     WHERE account_id = ?
       AND from_account_id = ?
       AND type = ?
       AND (status_id = ? OR (status_id IS NULL AND ? IS NULL))
     LIMIT 1`,
  )
    .bind(recipientAccountId, senderAccountId, notificationType, statusId ?? null, statusId ?? null)
    .first<{ id: string }>();

  if (existing) {
    console.log(`Notification already exists (${existing.id}), skipping`);
    return;
  }

  // Generate a notification ID
  const notificationId = generateULID();

  // Insert the notification
  await env.DB.prepare(
    `INSERT INTO notifications (id, account_id, from_account_id, type, status_id, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(notificationId, recipientAccountId, senderAccountId, notificationType, statusId ?? null)
    .run();

  console.log(
    `Created notification ${notificationId}: ${notificationType} from ${senderAccountId} to ${recipientAccountId}`,
  );

  // Look up the user for the recipient account to check for push subscriptions
  const user = await env.DB.prepare(
    `SELECT u.id FROM users u WHERE u.account_id = ? LIMIT 1`,
  )
    .bind(recipientAccountId)
    .first<{ id: string }>();

  if (!user) {
    // Remote account or no associated user — no push subscription
    return;
  }

  // Check if the user has a web push subscription
  const pushSub = await env.DB.prepare(
    `SELECT id FROM web_push_subscriptions WHERE user_id = ? LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: string }>();

  if (pushSub) {
    // Enqueue a web push message
    await env.QUEUE_INTERNAL.send({
      type: 'send_web_push',
      notificationId,
      userId: user.id,
    });
    console.log(`Enqueued web push for notification ${notificationId}`);
  }

  // Send streaming event for the notification
  // Build a minimal notification payload for the streaming event
  const senderAccount = await env.DB.prepare(
    `SELECT id, username, domain, display_name, note, url, uri,
            avatar_url, header_url, locked, bot,
            followers_count, following_count, statuses_count,
            created_at
     FROM accounts WHERE id = ? LIMIT 1`,
  )
    .bind(senderAccountId)
    .first();

  if (senderAccount) {
    // Build the notification payload
    const notificationPayload: Record<string, unknown> = {
      id: notificationId,
      type: notificationType,
      created_at: new Date().toISOString(),
      account: {
        id: senderAccount.id,
        username: senderAccount.username,
        acct: senderAccount.domain
          ? `${senderAccount.username}@${senderAccount.domain}`
          : senderAccount.username,
        display_name: senderAccount.display_name || '',
        locked: senderAccount.locked === 1 || senderAccount.locked === true,
        bot: senderAccount.bot === 1 || senderAccount.bot === true,
        discoverable: true,
        group: false,
        created_at: senderAccount.created_at,
        note: senderAccount.note || '',
        url: senderAccount.url,
        uri: senderAccount.uri,
        avatar: senderAccount.avatar_url || '',
        avatar_static: senderAccount.avatar_url || '',
        header: senderAccount.header_url || '',
        header_static: senderAccount.header_url || '',
        followers_count: senderAccount.followers_count || 0,
        following_count: senderAccount.following_count || 0,
        statuses_count: senderAccount.statuses_count || 0,
        last_status_at: null,
        emojis: [],
        fields: [],
      },
    };

    // Include status if applicable
    if (statusId) {
      const statusRow = await env.DB.prepare(
        `SELECT id, uri, content, visibility, sensitive, content_warning,
                language, url, created_at, in_reply_to_id,
                in_reply_to_account_id, reblogs_count, favourites_count,
                replies_count, edited_at, account_id
         FROM statuses WHERE id = ? LIMIT 1`,
      )
        .bind(statusId)
        .first();

      if (statusRow) {
        const statusAccount =
          statusRow.account_id === senderAccountId
            ? senderAccount
            : await env.DB.prepare(
                `SELECT id, username, domain, display_name, note, url, uri,
                        avatar_url, header_url, locked, bot,
                        followers_count, following_count, statuses_count,
                        created_at
                 FROM accounts WHERE id = ? LIMIT 1`,
              )
                .bind(statusRow.account_id)
                .first();

        if (statusAccount) {
          notificationPayload.status = {
            id: statusRow.id,
            uri: statusRow.uri,
            created_at: statusRow.created_at,
            content: statusRow.content,
            visibility: statusRow.visibility,
            sensitive: statusRow.sensitive === 1 || statusRow.sensitive === true,
            spoiler_text: statusRow.content_warning || '',
            language: statusRow.language,
            url: statusRow.url,
            in_reply_to_id: statusRow.in_reply_to_id,
            in_reply_to_account_id: statusRow.in_reply_to_account_id,
            reblogs_count: statusRow.reblogs_count || 0,
            favourites_count: statusRow.favourites_count || 0,
            replies_count: statusRow.replies_count || 0,
            edited_at: statusRow.edited_at,
            media_attachments: [],
            mentions: [],
            tags: [],
            emojis: [],
            reblog: null,
            poll: null,
            card: null,
            application: null,
            text: null,
            filtered: [],
            account: {
              id: statusAccount.id,
              username: statusAccount.username,
              acct: statusAccount.domain
                ? `${statusAccount.username}@${statusAccount.domain}`
                : statusAccount.username,
              display_name: statusAccount.display_name || '',
              locked: statusAccount.locked === 1 || statusAccount.locked === true,
              bot: statusAccount.bot === 1 || statusAccount.bot === true,
              discoverable: true,
              group: false,
              created_at: statusAccount.created_at,
              note: statusAccount.note || '',
              url: statusAccount.url,
              uri: statusAccount.uri,
              avatar: statusAccount.avatar_url || '',
              avatar_static: statusAccount.avatar_url || '',
              header: statusAccount.header_url || '',
              header_static: statusAccount.header_url || '',
              followers_count: statusAccount.followers_count || 0,
              following_count: statusAccount.following_count || 0,
              statuses_count: statusAccount.statuses_count || 0,
              last_status_at: null,
              emojis: [],
              fields: [],
            },
          };
        }
      }
    }

    // Send to streaming via worker service binding
    try {
      await env.WORKER.fetch(
        new Request('http://internal/internal/stream-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.id,
            event: 'notification',
            payload: JSON.stringify(notificationPayload),
            stream: ['user', 'user:notification'],
          }),
        }),
      );
      console.log(`Sent streaming notification event for ${notificationId}`);
    } catch (err) {
      console.error(`Failed to send streaming notification event:`, err);
    }
  }
}
