/**
 * Create Notification Handler
 *
 * Inserts a notification into the notifications table.
 * If the recipient has a web_push_subscription, enqueues
 * a send_web_push message for push delivery.
 */

import type { Env } from '../env';
import type { CreateNotificationMessage } from '../shared/types/queue';

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
       AND notification_type = ?
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
  const notificationId = crypto.randomUUID();

  // Insert the notification
  await env.DB.prepare(
    `INSERT INTO notifications (id, account_id, from_account_id, notification_type, status_id, created_at)
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
}
