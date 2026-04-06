/**
 * Create Notification Handler
 *
 * Inserts a notification into the notifications table.
 * If the recipient has a web_push_subscription, enqueues
 * a send_web_push message for push delivery.
 */

import { env } from 'cloudflare:workers';
import type { CreateNotificationMessage } from '../shared/types/queue';
import type { AccountRow, StatusRow } from '../../../packages/shared/types/db';
import { generateUlid } from '../../../packages/shared/utils/ulid';
import { serializeAccount, serializeStatus } from '../../../packages/shared/serializers/mastodonSerializer';

export async function handleCreateNotification(
  msg: CreateNotificationMessage,
): Promise<void> {
  const { recipientAccountId, senderAccountId, notificationType, statusId, emoji } = msg as CreateNotificationMessage & { emoji?: string };

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
  const notificationId = generateUlid();

  // Insert the notification
  await env.DB.prepare(
    `INSERT INTO notifications (id, account_id, from_account_id, type, status_id, emoji, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(notificationId, recipientAccountId, senderAccountId, notificationType, statusId ?? null, emoji ?? null)
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
    .first<AccountRow>();

  if (senderAccount) {
    const serializedSender = serializeAccount(senderAccount, { instanceDomain: env.INSTANCE_DOMAIN });

    const notificationPayload: Record<string, unknown> = {
      id: notificationId,
      type: notificationType,
      created_at: new Date().toISOString(),
      account: serializedSender,
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
        .first<StatusRow>();

      if (statusRow) {
        const statusAccountRow =
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
                .first<AccountRow>();

        if (statusAccountRow) {
          const statusAccount = serializeAccount(statusAccountRow, { instanceDomain: env.INSTANCE_DOMAIN });
          notificationPayload.status = serializeStatus(statusRow, { account: statusAccount });
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
