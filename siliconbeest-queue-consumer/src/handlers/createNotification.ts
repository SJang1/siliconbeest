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
import {
  canDeliverNotification,
  canViewStatus,
} from '../../../packages/shared/permissions';
import { sendStreamEvent } from '../../../siliconbeest/server/worker/services/streaming';

interface NotificationPermissionRow {
  recipient_domain: string | null;
  recipient_suspended_at: string | null;
  recipient_memorial: number;
  recipient_user_id: string;
  recipient_user_disabled: number;
  recipient_user_approved: number;
  sender_domain: string | null;
  sender_suspended_at: string | null;
  sender_memorial: number;
  sender_user_disabled: number | null;
  sender_user_approved: number | null;
  viewer_mutes_sender: number;
  viewer_blocks_sender: number;
  viewer_blocks_sender_domain: number;
  sender_blocks_viewer: number;
  viewer_mutes_status_thread: number;
  status_id: string | null;
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
}

export async function handleCreateNotification(
  msg: CreateNotificationMessage,
): Promise<void> {
  const {
    recipientAccountId,
    senderAccountId,
    notificationType,
    statusId,
    emoji,
  } = msg;

  // Don't notify yourself
  if (recipientAccountId === senderAccountId) {
    return;
  }

  const statusBearing = statusId !== undefined;
  const permissionRow = await env.DB.prepare(
    `SELECT recipient.domain AS recipient_domain,
            recipient.suspended_at AS recipient_suspended_at,
            recipient.memorial AS recipient_memorial,
            recipient_user.id AS recipient_user_id,
            recipient_user.disabled AS recipient_user_disabled,
            recipient_user.approved AS recipient_user_approved,
            sender.domain AS sender_domain,
            sender.suspended_at AS sender_suspended_at,
            sender.memorial AS sender_memorial,
            sender_user.disabled AS sender_user_disabled,
            sender_user.approved AS sender_user_approved,
            EXISTS (
              SELECT 1 FROM mutes mute
              WHERE mute.account_id = recipient.id
                AND mute.target_account_id = sender.id
                AND mute.hide_notifications != 0
                AND (mute.expires_at IS NULL OR mute.expires_at > ?4)
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
            EXISTS (
              SELECT 1
              FROM status_mutes status_mute
              JOIN statuses muted_status
                ON muted_status.id = status_mute.status_id
              WHERE status_mute.account_id = recipient.id
                AND (
                  status_mute.status_id = status.id
                  OR (
                    status.conversation_id IS NOT NULL
                    AND muted_status.conversation_id = status.conversation_id
                  )
                )
            ) AS viewer_mutes_status_thread,
            status.id AS status_id,
            status.account_id AS status_account_id,
            status.visibility AS status_visibility,
            status.deleted_at AS status_deleted_at,
            status_author.suspended_at AS status_author_suspended_at,
            status_author.silenced_at AS status_author_silenced_at,
            EXISTS (
              SELECT 1 FROM follows follow
              WHERE follow.account_id = recipient.id
                AND follow.target_account_id = status.account_id
            ) AS viewer_follows_status_author,
            EXISTS (
              SELECT 1 FROM mentions mention
              WHERE mention.status_id = status.id
                AND mention.account_id = recipient.id
            ) AS viewer_is_mentioned,
            EXISTS (
              SELECT 1 FROM mutes status_author_mute
              WHERE status_author_mute.account_id = recipient.id
                AND status_author_mute.target_account_id = status.account_id
                AND status_author_mute.hide_notifications != 0
                AND (
                  status_author_mute.expires_at IS NULL
                  OR status_author_mute.expires_at > ?4
                )
            ) AS viewer_mutes_status_author,
            EXISTS (
              SELECT 1 FROM blocks status_author_viewer_block
              WHERE status_author_viewer_block.account_id = recipient.id
                AND status_author_viewer_block.target_account_id = status.account_id
            ) AS viewer_blocks_status_author,
            EXISTS (
              SELECT 1 FROM user_domain_blocks status_author_domain_block
              WHERE status_author_domain_block.account_id = recipient.id
                AND status_author.domain IS NOT NULL
                AND lower(status_author_domain_block.domain) = lower(status_author.domain)
            ) AS viewer_blocks_status_author_domain,
            EXISTS (
              SELECT 1 FROM blocks status_author_block
              WHERE status_author_block.account_id = status.account_id
                AND status_author_block.target_account_id = recipient.id
            ) AS status_author_blocks_viewer
     FROM accounts recipient
     JOIN users recipient_user ON recipient_user.account_id = recipient.id
     JOIN accounts sender ON sender.id = ?2
     LEFT JOIN users sender_user ON sender_user.account_id = sender.id
     LEFT JOIN statuses status ON status.id = ?3
     LEFT JOIN accounts status_author ON status_author.id = status.account_id
     WHERE recipient.id = ?1
     LIMIT 1`,
  )
    .bind(
      recipientAccountId,
      senderAccountId,
      statusId ?? null,
      new Date().toISOString(),
    )
    .first<NotificationPermissionRow>();

  const statusViewable = statusBearing
    ? canViewStatus({
        visibility: permissionRow?.status_visibility ?? null,
        viewerAccountId: recipientAccountId,
        authorAccountId: permissionRow?.status_account_id ?? null,
        viewerFollowsAuthor:
          permissionRow?.viewer_follows_status_author === 1,
        viewerIsMentioned: permissionRow?.viewer_is_mentioned === 1,
        authorBlocksViewer:
          permissionRow?.status_author_blocks_viewer === 1,
        statusDeleted:
          !permissionRow?.status_id
          || permissionRow.status_deleted_at !== null,
      })
    : null;

  const statusSurface = statusBearing
    ? {
        statusViewable: statusViewable === true,
        authorSuspended: permissionRow?.status_id
          ? permissionRow.status_author_suspended_at !== null
          : null,
        authorSilenced: permissionRow?.status_id
          ? permissionRow.status_author_silenced_at !== null
          : null,
        viewerIsAuthor:
          permissionRow?.status_account_id === recipientAccountId,
        viewerFollowsAuthor:
          permissionRow?.viewer_follows_status_author === 1,
        viewerMutesAuthor: permissionRow
          ? permissionRow.viewer_mutes_status_author !== 0
          : null,
        viewerBlocksAuthor: permissionRow
          ? permissionRow.viewer_blocks_status_author !== 0
          : null,
        viewerBlocksAuthorDomain: permissionRow
          ? permissionRow.viewer_blocks_status_author_domain !== 0
          : null,
        authorBlocksViewer: permissionRow
          ? permissionRow.status_author_blocks_viewer !== 0
          : null,
      }
    : null;

  const permitted = canDeliverNotification({
    recipientOperational: {
      accountSuspended:
        permissionRow && permissionRow.recipient_domain === null
          ? permissionRow.recipient_suspended_at !== null
          : null,
      userDisabled: permissionRow
        ? permissionRow.recipient_user_disabled !== 0
        : null,
      userApproved: permissionRow
        ? permissionRow.recipient_user_approved !== 0
        : null,
      memorial: permissionRow
        ? permissionRow.recipient_memorial !== 0
        : null,
    },
    senderOperational: {
      accountSuspended: permissionRow
        ? permissionRow.sender_suspended_at !== null
        : null,
      accountMemorial: permissionRow
        ? permissionRow.sender_memorial !== 0
        : null,
      isLocalAccount: permissionRow
        ? permissionRow.sender_domain === null
        : null,
      userDisabled: permissionRow?.sender_user_disabled === null
        || permissionRow?.sender_user_disabled === undefined
        ? null
        : permissionRow.sender_user_disabled !== 0,
      userApproved: permissionRow?.sender_user_approved === null
        || permissionRow?.sender_user_approved === undefined
        ? null
        : permissionRow.sender_user_approved !== 0,
    },
    viewerMutesSender: permissionRow
      ? permissionRow.viewer_mutes_sender !== 0
      : null,
    viewerBlocksSender: permissionRow
      ? permissionRow.viewer_blocks_sender !== 0
      : null,
    viewerBlocksSenderDomain: permissionRow
      ? permissionRow.viewer_blocks_sender_domain !== 0
      : null,
    senderBlocksViewer: permissionRow
      ? permissionRow.sender_blocks_viewer !== 0
      : null,
    statusBearing,
    statusSurface,
    viewerMutesStatusThread: statusBearing
      ? permissionRow
        ? permissionRow.viewer_mutes_status_thread !== 0
        : null
      : null,
  });

  if (!permissionRow || !permitted) {
    console.warn(
      `Dropping unauthorized ${notificationType} notification from ${senderAccountId} to ${recipientAccountId}`,
    );
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

  // Check if the user has a web push subscription
  const pushSub = await env.DB.prepare(
    `SELECT id FROM web_push_subscriptions WHERE user_id = ? LIMIT 1`,
  )
    .bind(permissionRow.recipient_user_id)
    .first<{ id: string }>();

  if (pushSub) {
    // Enqueue a web push message
    await env.QUEUE_INTERNAL.send({
      type: 'send_web_push',
      notificationId,
      userId: permissionRow.recipient_user_id,
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

    // Send to streaming through the main Worker's internal RPC entrypoint.
    try {
      await sendStreamEvent(permissionRow.recipient_user_id, {
        event: 'notification',
        payload: JSON.stringify(notificationPayload),
        stream: ['user', 'user:notification'],
      });
      console.log(`Sent streaming notification event for ${notificationId}`);
    } catch (err) {
      console.error(`Failed to send streaming notification event:`, err);
    }
  }
}
