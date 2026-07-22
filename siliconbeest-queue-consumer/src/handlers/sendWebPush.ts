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

import { env } from 'cloudflare:workers';
import type { SendWebPushMessage } from '../shared/types/queue';
import { base64urlDecode, sendPushNotification } from '../shared/webpush';
import {
  canDeliverNotification,
  canViewStatus,
  notificationBelongsToUser,
} from '../../../packages/shared/permissions';

interface PushNotificationPermissionRow {
  id: string;
  notification_type: string;
  status_id: string | null;
  notification_recipient_account_id: string;
  user_account_id: string | null;
  user_disabled: number | null;
  user_approved: number | null;
  recipient_suspended_at: string | null;
  recipient_memorial: number;
  sender_domain: string | null;
  sender_suspended_at: string | null;
  sender_memorial: number;
  sender_user_disabled: number | null;
  sender_user_approved: number | null;
  viewer_mutes_sender: number;
  viewer_blocks_sender: number;
  viewer_blocks_sender_domain: number;
  sender_blocks_viewer: number;
  status_account_id: string | null;
  status_visibility: string | null;
  status_deleted_at: string | null;
  status_author_suspended_at: string | null;
  status_author_silenced_at: string | null;
  viewer_follows_status_author: number;
  viewer_is_mentioned: number;
  viewer_mutes_status_author: number;
  viewer_blocks_status_author: number;
  viewer_blocks_status_author_domain: number;
  status_author_blocks_viewer: number;
  viewer_mutes_status_thread: number;
  sender_username: string;
  sender_display_name: string;
  status_username: string | null;
  status_domain: string | null;
}

export async function handleSendWebPush(
  msg: SendWebPushMessage,
): Promise<void> {
  const { notificationId, userId } = msg;
  const permissionCheckAt = new Date().toISOString();

  // Load the notification details
  const notification = await env.DB_META_C000.prepare(
    `SELECT n.id, n.type AS notification_type, n.status_id,
            n.account_id AS notification_recipient_account_id,
            recipient_user.account_id AS user_account_id,
            recipient_user.disabled AS user_disabled,
            recipient_user.approved AS user_approved,
            recipient.suspended_at AS recipient_suspended_at,
            recipient.memorial AS recipient_memorial,
            sender.domain AS sender_domain,
            sender.suspended_at AS sender_suspended_at,
            sender.memorial AS sender_memorial,
            sender_user.disabled AS sender_user_disabled,
            sender_user.approved AS sender_user_approved,
            EXISTS (
              SELECT 1 FROM mutes sender_mute
              WHERE sender_mute.account_id = recipient.id
                AND sender_mute.target_account_id = sender.id
                AND sender_mute.hide_notifications != 0
                AND (
                  sender_mute.expires_at IS NULL
                  OR sender_mute.expires_at > ?3
                )
            ) AS viewer_mutes_sender,
            EXISTS (
              SELECT 1 FROM blocks viewer_block
              WHERE viewer_block.account_id = recipient.id
                AND viewer_block.target_account_id = sender.id
            ) AS viewer_blocks_sender,
            EXISTS (
              SELECT 1 FROM user_domain_blocks sender_domain_block
              WHERE sender_domain_block.account_id = recipient.id
                AND sender.domain IS NOT NULL
                AND lower(sender_domain_block.domain) = lower(sender.domain)
            ) AS viewer_blocks_sender_domain,
            EXISTS (
              SELECT 1 FROM blocks sender_block
              WHERE sender_block.account_id = sender.id
                AND sender_block.target_account_id = recipient.id
            ) AS sender_blocks_viewer,
            s.account_id AS status_account_id,
            s.visibility AS status_visibility,
            s.deleted_at AS status_deleted_at,
            status_account.suspended_at AS status_author_suspended_at,
            status_account.silenced_at AS status_author_silenced_at,
            EXISTS (
              SELECT 1 FROM follows status_follow
              WHERE status_follow.account_id = recipient.id
                AND status_follow.target_account_id = s.account_id
            ) AS viewer_follows_status_author,
            EXISTS (
              SELECT 1 FROM mentions status_mention
              WHERE status_mention.status_id = s.id
                AND status_mention.account_id = recipient.id
            ) AS viewer_is_mentioned,
            EXISTS (
              SELECT 1 FROM mutes status_author_mute
              WHERE status_author_mute.account_id = recipient.id
                AND status_author_mute.target_account_id = s.account_id
                AND status_author_mute.hide_notifications != 0
                AND (
                  status_author_mute.expires_at IS NULL
                  OR status_author_mute.expires_at > ?3
                )
            ) AS viewer_mutes_status_author,
            EXISTS (
              SELECT 1 FROM blocks status_author_viewer_block
              WHERE status_author_viewer_block.account_id = recipient.id
                AND status_author_viewer_block.target_account_id = s.account_id
            ) AS viewer_blocks_status_author,
            EXISTS (
              SELECT 1 FROM user_domain_blocks status_author_domain_block
              WHERE status_author_domain_block.account_id = recipient.id
                AND status_account.domain IS NOT NULL
                AND lower(status_author_domain_block.domain) = lower(status_account.domain)
            ) AS viewer_blocks_status_author_domain,
            EXISTS (
              SELECT 1 FROM blocks status_author_block
              WHERE status_author_block.account_id = s.account_id
                AND status_author_block.target_account_id = recipient.id
            ) AS status_author_blocks_viewer,
            EXISTS (
              SELECT 1
              FROM status_mutes status_mute
              JOIN statuses muted_status
                ON muted_status.id = status_mute.status_id
              WHERE status_mute.account_id = recipient.id
                AND (
                  status_mute.status_id = s.id
                  OR (
                    s.conversation_id IS NOT NULL
                    AND muted_status.conversation_id = s.conversation_id
                  )
                )
            ) AS viewer_mutes_status_thread,
            sender.username AS sender_username,
            sender.display_name AS sender_display_name,
            status_account.username AS status_username,
            status_account.domain AS status_domain
     FROM notifications n
     JOIN accounts sender ON sender.id = n.from_account_id
     JOIN accounts recipient ON recipient.id = n.account_id
     LEFT JOIN users sender_user ON sender_user.account_id = sender.id
     LEFT JOIN users recipient_user ON recipient_user.id = ?1
     LEFT JOIN statuses s ON s.id = n.status_id
     LEFT JOIN accounts status_account ON status_account.id = s.account_id
     WHERE n.id = ?2`,
  )
    .bind(userId, notificationId, permissionCheckAt)
    .first<PushNotificationPermissionRow>();

  if (!notification) {
    console.warn(`Notification ${notificationId} not found, dropping web push`);
    return;
  }

  const ownsNotification = notificationBelongsToUser({
    notificationRecipientAccountId:
      notification.notification_recipient_account_id,
    userAccountId: notification.user_account_id,
    userDisabled: notification.user_disabled === null
      ? null
      : notification.user_disabled !== 0,
    userApproved: notification.user_approved === null
      ? null
      : notification.user_approved !== 0,
    recipientSuspended: notification.recipient_suspended_at !== null,
    recipientMemorial: notification.recipient_memorial === null
      ? null
      : notification.recipient_memorial !== 0,
  });

  if (!ownsNotification) {
    console.warn(
      `Dropping unauthorized web push for notification ${notificationId} and user ${userId}`,
    );
    return;
  }

  const statusBearing = notification.status_id !== null;
  const statusViewable = statusBearing
    ? canViewStatus({
        visibility: notification.status_visibility,
        viewerAccountId: notification.notification_recipient_account_id,
        authorAccountId: notification.status_account_id,
        viewerFollowsAuthor:
          notification.viewer_follows_status_author !== 0,
        viewerIsMentioned: notification.viewer_is_mentioned !== 0,
        authorBlocksViewer:
          notification.status_author_blocks_viewer !== 0,
        statusDeleted:
          notification.status_account_id === null
          || notification.status_deleted_at !== null,
      })
    : null;
  const permitted = canDeliverNotification({
    recipientOperational: {
      accountSuspended: notification.recipient_suspended_at !== null,
      userDisabled: notification.user_disabled === null
        ? null
        : notification.user_disabled !== 0,
      userApproved: notification.user_approved === null
        ? null
        : notification.user_approved !== 0,
      memorial: notification.recipient_memorial !== 0,
    },
    senderOperational: {
      accountSuspended: notification.sender_suspended_at !== null,
      accountMemorial: notification.sender_memorial !== 0,
      isLocalAccount: notification.sender_domain === null,
      userDisabled: notification.sender_user_disabled === null
        ? null
        : notification.sender_user_disabled !== 0,
      userApproved: notification.sender_user_approved === null
        ? null
        : notification.sender_user_approved !== 0,
    },
    viewerMutesSender: notification.viewer_mutes_sender !== 0,
    viewerBlocksSender: notification.viewer_blocks_sender !== 0,
    viewerBlocksSenderDomain:
      notification.viewer_blocks_sender_domain !== 0,
    senderBlocksViewer: notification.sender_blocks_viewer !== 0,
    statusBearing,
    statusSurface: statusBearing
      ? {
          statusViewable: statusViewable === true,
          authorSuspended:
            notification.status_author_suspended_at !== null,
          authorSilenced:
            notification.status_author_silenced_at !== null,
          viewerIsAuthor:
            notification.status_account_id
              === notification.notification_recipient_account_id,
          viewerFollowsAuthor:
            notification.viewer_follows_status_author !== 0,
          viewerMutesAuthor:
            notification.viewer_mutes_status_author !== 0,
          viewerBlocksAuthor:
            notification.viewer_blocks_status_author !== 0,
          viewerBlocksAuthorDomain:
            notification.viewer_blocks_status_author_domain !== 0,
          authorBlocksViewer:
            notification.status_author_blocks_viewer !== 0,
        }
      : null,
    viewerMutesStatusThread: statusBearing
      ? notification.viewer_mutes_status_thread !== 0
      : null,
  });

  if (!permitted) {
    console.warn(
      `Dropping stale or unauthorized web push for notification ${notificationId}`,
    );
    return;
  }

  // Load all push subscriptions for the user
  const subscriptions = await env.DB_META_C000.prepare(
    `SELECT id, endpoint, key_p256dh, key_auth
     FROM web_push_subscriptions
     WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{
      id: string;
      endpoint: string;
      key_p256dh: string;
      key_auth: string;
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
    url: buildNotificationUrl(notification),
  });

  // Load VAPID keys from DB settings
  const vapidRows = await env.DB_META_C000
    .prepare("SELECT key, value FROM settings WHERE key IN ('vapid_public_key', 'vapid_private_key')")
    .all<{ key: string; value: string }>();
  const vapidMap: Record<string, string> = {};
  for (const row of vapidRows.results || []) {
    if (row.value) vapidMap[row.key] = row.value;
  }
  const vapidPublicKey = vapidMap.vapid_public_key || '';
  const vapidPrivateKey = vapidMap.vapid_private_key || '';

  if (!vapidPrivateKey || !vapidPublicKey) {
    console.warn('[web-push] VAPID keys not configured in DB settings, skipping push');
    return;
  }

  // Validate VAPID key formats before attempting push
  try {
    const pubBytes = base64urlDecode(vapidPublicKey);
    const privBytes = base64urlDecode(vapidPrivateKey);
    if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
      console.error(`[web-push] Invalid VAPID public key: expected 65 bytes (0x04 prefix), got ${pubBytes.length} bytes (prefix 0x${pubBytes[0]?.toString(16)})`);
      return;
    }
    if (privBytes.length !== 32) {
      console.error(`[web-push] Invalid VAPID private key: expected 32 bytes, got ${privBytes.length} bytes`);
      return;
    }
  } catch (e) {
    console.error(`[web-push] Failed to decode VAPID keys (not valid base64url):`, e);
    return;
  }

  // Send to each subscription
  for (const sub of subscriptions.results) {
    try {
      const result = await sendPushNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.key_p256dh,
            auth: sub.key_auth,
          },
        },
        payload,
        vapidPrivateKey,
        vapidPublicKey,
        'mailto:admin@siliconbeest.com',
      );

      if (result.gone) {
        // Subscription is stale — remove it
        await env.DB_META_C000.prepare(
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

function buildNotificationUrl(notification: {
  status_id: string | null;
  sender_username: string;
  sender_domain: string | null;
  status_username: string | null;
  status_domain: string | null;
}): string {
  if (notification.status_id && notification.status_username) {
    const acct = notification.status_domain
      ? `${notification.status_username}@${notification.status_domain}`
      : notification.status_username;
    return `https://${env.INSTANCE_DOMAIN}/@${acct}/${notification.status_id}`;
  }

  const senderAcct = notification.sender_domain
    ? `${notification.sender_username}@${notification.sender_domain}`
    : notification.sender_username;
  return `https://${env.INSTANCE_DOMAIN}/@${senderAcct}`;
}
