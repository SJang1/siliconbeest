/**
 * SiliconBeest Queue Consumer
 *
 * Cloudflare Worker that consumes messages from the federation
 * and internal queues. Dispatches each message to the appropriate
 * handler based on the discriminated union type field.
 *
 * Fedify messages (enqueued by WorkersMessageQueue via sendActivity)
 * are detected and routed to federation.processQueuedTask().
 */

import type { Env } from './env';
import type { QueueMessage } from './shared/types/queue';
import { createFed } from './fedify';
import { setupActorDispatcher } from './dispatchers';
import { WorkersMessageQueue } from '@fedify/cfworkers';

// Consumer-local inbox listeners and collection dispatchers.
// These files use Fedify vocab types from the consumer's own node_modules,
// avoiding the dual-package hazard that occurs when importing from the worker.
import { setupInboxListeners } from './inboxListeners';
import { setupCollectionDispatchers } from './collectionDispatchers';
import { handleDeliverActivity } from './handlers/deliverActivity';
import { handleDeliverActivityFanout } from './handlers/deliverActivityFanout';
import { handleTimelineFanout } from './handlers/timelineFanout';
import { handleCreateNotification } from './handlers/createNotification';
import { handleProcessMedia } from './handlers/processMedia';
import { handleFetchRemoteAccount } from './handlers/fetchRemoteAccount';
import { handleFetchRemoteStatus } from './handlers/fetchRemoteStatus';
import { handleSendWebPush } from './handlers/sendWebPush';
import { handleFetchPreviewCard } from './handlers/fetchPreviewCard';
import { handleForwardActivity } from './handlers/forwardActivity';
import { handleImportItem } from './handlers/importItem';

// ---------------------------------------------------------------------------
// Fedify — singleton per isolate (avoids createFederation + setup per message)
// ---------------------------------------------------------------------------
let fedInitialized = false;

function ensureFedInitialized(env: Env) {
  const fed = createFed(env);
  if (!fedInitialized) {
    setupActorDispatcher(fed);
    setupInboxListeners(fed);
    setupCollectionDispatchers(fed);
    fedInitialized = true;
  }
  return fed;
}

/** All legacy message type values used by our own queue messages. */
const LEGACY_MESSAGE_TYPES = new Set([
  'deliver_activity',
  'deliver_activity_fanout',
  'timeline_fanout',
  'create_notification',
  'process_media',
  'fetch_remote_account',
  'fetch_remote_status',
  'send_web_push',
  'cleanup_expired_tokens',
  'update_trends',
  'fetch_preview_card',
  'forward_activity',
  'deliver_report',
  'update_instance_info',
  'import_item',
]);

/**
 * Determine whether a queue message body is a Fedify message
 * (enqueued by WorkersMessageQueue) rather than one of our
 * legacy discriminated-union messages.
 *
 * Fedify messages do NOT carry a `type` field that matches any
 * of our known legacy types.
 */
function isFedifyMessage(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const msg = body as Record<string, unknown>;
  if ('type' in msg && typeof msg.type === 'string' && LEGACY_MESSAGE_TYPES.has(msg.type)) {
    return false;
  }
  // If there's no `type` field at all, or the type is not one of ours,
  // treat it as a Fedify message.
  return true;
}

export default {
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as Record<string, unknown>;

        // ---- Fedify queued tasks (from WorkersMessageQueue / sendActivity) ----
        if (isFedifyMessage(body)) {
          try {
            const fed = ensureFedInitialized(env);

            const wmq = new WorkersMessageQueue(env.QUEUE_FEDERATION);
            const result = await wmq.processMessage(body);
            console.log('[queue] processMessage result:', JSON.stringify({
              shouldProcess: result.shouldProcess,
              messageType: (result as any).message?.type,
              messageKeys: Object.keys((result as any).message || {}),
            }));
            if (!result.shouldProcess) {
              console.log('[queue] Fedify message deferred (ordering lock)');
              msg.retry();
              continue;
            }
            try {
              console.log('[queue] Calling processQueuedTask with message type:', (result as any).message?.type);
              await fed.processQueuedTask({ env }, result.message);
              console.log('[queue] Fedify task processed successfully');
              msg.ack();
            } catch (taskErr) {
              console.error('[queue] Fedify processQueuedTask error:', taskErr);
              msg.retry();
            } finally {
              await result.release?.();
            }
          } catch (fedifyErr) {
            console.error('[queue] Fedify setup error:', fedifyErr);
            msg.retry();
          }
          continue;
        }

        // ---- Legacy messages (discriminated union on `type`) ----
        const legacyMsg = body as unknown as QueueMessage; // body is checked by isFedifyMessage() above
        switch (legacyMsg.type) {
          case 'deliver_activity':
            await handleDeliverActivity(legacyMsg, env);
            break;
          case 'deliver_activity_fanout':
            await handleDeliverActivityFanout(legacyMsg, env);
            break;
          case 'timeline_fanout':
            await handleTimelineFanout(legacyMsg, env);
            break;
          case 'create_notification':
            await handleCreateNotification(legacyMsg, env);
            break;
          case 'process_media':
            await handleProcessMedia(legacyMsg, env);
            break;
          case 'fetch_remote_account':
            await handleFetchRemoteAccount(legacyMsg, env);
            break;
          case 'fetch_remote_status':
            await handleFetchRemoteStatus(legacyMsg, env);
            break;
          case 'send_web_push':
            await handleSendWebPush(legacyMsg, env);
            break;
          case 'fetch_preview_card':
            await handleFetchPreviewCard(legacyMsg, env);
            break;
          case 'forward_activity':
            await handleForwardActivity(legacyMsg, env);
            break;
          case 'import_item':
            await handleImportItem(legacyMsg, env);
            break;
          default:
            console.warn('Unknown message type:', (legacyMsg as any).type);
        }
        msg.ack();
      } catch (err) {
        const bodyType =
          msg.body && typeof msg.body === 'object' && 'type' in (msg.body as Record<string, unknown>)
            ? (msg.body as Record<string, unknown>).type
            : 'fedify-task';
        console.error(`Queue handler error for ${bodyType}:`, err);
        msg.retry();
      }
    }
  },
};
