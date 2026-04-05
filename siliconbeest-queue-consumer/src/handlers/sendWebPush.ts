/**
 * Send Web Push Handler
 *
 * Loads web push subscriptions for a user, encrypts the notification
 * payload per RFC 8291, signs with VAPID (RFC 8292), and POSTs to
 * each push service endpoint.
 *
 * Stale subscriptions (410 Gone / 404 Not Found) are automatically
 * cleaned up from the database.
 */

import type { Env } from '../env';
import type { SendWebPushMessage } from '../shared/types/queue';
import { sendPushNotification } from '../shared/webpush';

export async function handleSendWebPush(
  msg: SendWebPushMessage,
  env: Env,
): Promise<void> {
  const { notificationId, userId } = msg;

  // Load the notification details
  const notification = await env.DB.prepare(
    `SELECT n.id, n.type AS notification_type, n.status_id,
            sender.username AS sender_username,
            sender.display_name AS sender_display_name
     FROM notifications n
     JOIN accounts sender ON sender.id = n.from_account_id
     WHERE n.id = ?`,
  )
    .bind(notificationId)
    .first<{
      id: string;
      notification_type: string;
      status_id: string | null;
      sender_username: string;
      sender_display_name: string;
    }>();

  if (!notification) {
    console.warn(`Notification ${notificationId} not found, dropping web push`);
    return;
  }

  // Load all push subscriptions for the user
  const subscriptions = await env.DB.prepare(
    `SELECT id, endpoint, p256dh_key, auth_key
     FROM web_push_subscriptions
     WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{
      id: string;
      endpoint: string;
      p256dh_key: string;
      auth_key: string;
    }>();

  if (!subscriptions.results || subscriptions.results.length === 0) {
    console.log(`No push subscriptions for user ${userId}, skipping`);
    return;
  }

  // Build the push payload
  const payload = JSON.stringify({
    notification_id: notification.id,
    notification_type: notification.notification_type,
    title: buildNotificationTitle(notification),
    body: buildNotificationBody(notification),
    status_id: notification.status_id,
  });

  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    console.warn('[web-push] VAPID keys not configured, skipping push');
    return;
  }

  // Send to each subscription
  for (const sub of subscriptions.results) {
    try {
      const result = await sendPushNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh_key,
            auth: sub.auth_key,
          },
        },
        payload,
        env.VAPID_PRIVATE_KEY,
        env.VAPID_PUBLIC_KEY,
        'mailto:admin@siliconbeest.com',
      );

      if (result.gone) {
        // Subscription is stale — remove it
        await env.DB.prepare(
          `DELETE FROM web_push_subscriptions WHERE id = ?`,
        )
          .bind(sub.id)
          .run();
        console.log(
          `Removed stale push subscription ${sub.id} (status ${result.status})`,
        );
      } else if (!result.success) {
        console.error(
          `Push delivery to ${sub.endpoint} failed with status ${result.status}`,
        );
      }
    } catch (err) {
      console.error(`Failed to send push to ${sub.endpoint}:`, err);
    }
  }
}

// ============================================================
// NOTIFICATION TEXT BUILDERS
// ============================================================

function buildNotificationTitle(notification: {
  notification_type: string;
  sender_display_name: string;
  sender_username: string;
}): string {
  const sender = notification.sender_display_name || notification.sender_username;

  switch (notification.notification_type) {
    case 'follow':
      return `${sender} followed you`;
    case 'favourite':
      return `${sender} favourited your post`;
    case 'reblog':
      return `${sender} boosted your post`;
    case 'mention':
      return `${sender} mentioned you`;
    case 'poll':
      return 'A poll you voted in has ended';
    case 'follow_request':
      return `${sender} requested to follow you`;
    case 'update':
      return `${sender} edited a post`;
    default:
      return `Notification from ${sender}`;
  }
}

function buildNotificationBody(notification: {
  notification_type: string;
  sender_username: string;
}): string {
  return `@${notification.sender_username}`;
}
