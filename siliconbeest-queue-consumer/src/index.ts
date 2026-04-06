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

import { env } from 'cloudflare:workers';
import type { QueueMessage } from './shared/types/queue';
import { createFed } from './fedify';
import { setupActorDispatcher } from './dispatchers';
import { WorkersMessageQueue } from '@fedify/cfworkers';
import { measureAsync, logPerformance } from './observability/performance';

// Consumer-local inbox listeners and collection dispatchers.
// These files use Fedify vocab types from the consumer's own node_modules,
// avoiding the dual-package hazard that occurs when importing from the worker.
import { setupConsumerInboxListeners } from './inboxListeners';
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

function ensureFedInitialized() {
  const fed = createFed();
  if (!fedInitialized) {
    setupActorDispatcher(fed);
    setupConsumerInboxListeners(fed);
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

/**
 * Typed shape of the object returned by WorkersMessageQueue.processMessage().
 * The Fedify SDK does not expose this as a public type, so we define a local
 * interface that matches the fields we access.
 */
interface ProcessMessageResult {
  shouldProcess: boolean;
  /** The inner Fedify Message — typed as `any` because the SDK doesn't export the Message type. */
  message?: any;
  release?: () => Promise<void>;
  [key: string]: unknown;
}

export default {
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const batchStart = performance.now();

    for (const msg of batch.messages) {
      const messageStart = performance.now();
      try {
        const body = msg.body as Record<string, unknown>;

        // ---- Fedify queued tasks (from WorkersMessageQueue / sendActivity) ----
        if (isFedifyMessage(body)) {
          try {
            const fed = ensureFedInitialized();

            // @ts-expect-error — @fedify/cfworkers uses experimental workers-types internally
            const wmq = new WorkersMessageQueue(env.QUEUE_FEDERATION);
            const result = await measureAsync('queue.fedify.processMessage', () => wmq.processMessage(body)) as ProcessMessageResult;
            console.log('[queue] processMessage result:', JSON.stringify({
              shouldProcess: result.shouldProcess,
              messageType: result.message?.type,
              messageKeys: Object.keys(result.message || {}),
            }));
            if (!result.shouldProcess) {
              console.log('[queue] Fedify message deferred (ordering lock)');
              msg.retry();
              const deferDuration = performance.now() - messageStart;
              logPerformance('queue.message.deferred', deferDuration, { messageType: 'fedify' });
              continue;
            }
            try {
              console.log('[queue] Calling processQueuedTask with message type:', result.message?.type);
              await measureAsync(
                'queue.fedify.processQueuedTask',
                () => fed.processQueuedTask({ env }, result.message!),
                { messageType: result.message?.type }
              );
              console.log('[queue] Fedify task processed successfully');
              msg.ack();
              const totalDuration = performance.now() - messageStart;
              logPerformance('queue.message.processed', totalDuration, {
                messageType: 'fedify',
                taskType: result.message?.type
              });
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
        await measureAsync(
          `queue.legacy.${legacyMsg.type}`,
          async () => {
            switch (legacyMsg.type) {
              case 'deliver_activity':
                await handleDeliverActivity(legacyMsg);
                break;
              case 'deliver_activity_fanout':
                await handleDeliverActivityFanout(legacyMsg);
                break;
              case 'timeline_fanout':
                await handleTimelineFanout(legacyMsg);
                break;
              case 'create_notification':
                await handleCreateNotification(legacyMsg);
                break;
              case 'process_media':
                await handleProcessMedia(legacyMsg);
                break;
              case 'fetch_remote_account':
                await handleFetchRemoteAccount(legacyMsg);
                break;
              case 'fetch_remote_status':
                await handleFetchRemoteStatus(legacyMsg);
                break;
              case 'send_web_push':
                await handleSendWebPush(legacyMsg);
                break;
              case 'fetch_preview_card':
                await handleFetchPreviewCard(legacyMsg);
                break;
              case 'forward_activity':
                await handleForwardActivity(legacyMsg);
                break;
              case 'import_item':
                await handleImportItem(legacyMsg);
                break;
              default:
                console.warn('Unknown message type:', (legacyMsg as { type: string }).type);
            }
          },
          { messageType: legacyMsg.type }
        );
        msg.ack();
        const totalDuration = performance.now() - messageStart;
        logPerformance('queue.message.processed', totalDuration, { 
          messageType: 'legacy',
          legacyType: legacyMsg.type 
        });
      } catch (err) {
        const bodyType =
          msg.body && typeof msg.body === 'object' && 'type' in (msg.body as Record<string, unknown>)
            ? (msg.body as Record<string, unknown>).type
            : 'fedify-task';
        const errorDuration = performance.now() - messageStart;
        logPerformance('queue.message.error', errorDuration, {
          messageType: bodyType,
          error: err instanceof Error ? err.message : String(err),
          attempt: msg.attempts,
        });
        console.error(`Queue handler error for ${bodyType} (attempt ${msg.attempts}):`, err);
        // Max retry reached — log and ack to prevent infinite loop
        // (federation queue max_retries=5, internal queue max_retries=3)
        const MAX_ATTEMPTS = isFedifyMessage(msg.body) ? 6 : 4; // max_retries + 1 (first attempt)
        if (msg.attempts >= MAX_ATTEMPTS) {
          console.error(`[queue] DROPPED after ${msg.attempts} attempts: ${bodyType}`, JSON.stringify(msg.body));
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
    
    const batchDuration = performance.now() - batchStart;
    logPerformance('queue.batch.complete', batchDuration, { 
      messageCount: batch.messages.length 
    });
  },
};
