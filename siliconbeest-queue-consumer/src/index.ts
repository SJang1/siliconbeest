/**
 * SiliconBeest Queue Consumer
 *
 * Cloudflare Worker that consumes messages from the federation,
 * internal, and federation-dlq queues. Dispatches each message to
 * the appropriate handler based on the discriminated union type field.
 *
 * Fedify messages (enqueued by WorkersMessageQueue via sendActivity)
 * are detected and routed to federation.processQueuedTask().
 *
 * Retry semantics per queue:
 * - federation: on failure always retry(); Cloudflare moves the message
 *   to the federation-dlq queue once max_retries is exhausted.
 * - internal: no DLQ — poison messages are dropped after max attempts.
 * - federation-dlq: reprocess once more; persistent failures are parked
 *   into the `federation_dlq_parked` D1 table (admin API can replay or
 *   discard them), then acked.
 */

import { env } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import type { QueueMessage } from './shared/types/queue';
import { createFed } from './fedify';
import { setupActorDispatcher } from './dispatchers';
import { WorkersMessageQueue } from '@fedify/cfworkers';
import { measureAsync, logPerformance } from './observability/performance';
import { debugLog } from '../../packages/shared/utils/debugLog';
import { ensureFedifyDebugLogging } from './utils/debugLogtape';
import { ensureDebugSentryLogging } from './utils/debugSentry';
import { ensureDebugBindingLogging } from './utils/debugBindings';

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
import {
  handleRefreshRemoteInstance,
  handleResetRemoteInstanceCache,
} from './handlers/manageRemoteInstance';
import {
  getSuspendedDeliveryInboxes,
  getSuspendedDomains,
} from '../../packages/shared/domain-blocks';
import {
  filterSuspendedFedifyTargets,
  getFedifyInboxUrls,
  getFedifyTargetDomains,
} from './federationPolicy';

// ---------------------------------------------------------------------------
// Queue name classification
// ---------------------------------------------------------------------------
// The prefix is configurable (PROJECT_PREFIX in scripts/config.sh); the
// suffixes are fixed by scripts/install.sh and scripts/sync-config.sh.
const DLQ_QUEUE_SUFFIX = '-federation-dlq';
const INTERNAL_QUEUE_SUFFIX = '-internal';

/** Internal queue has no DLQ: drop poison messages after max_retries=3 (+1 first attempt). */
const INTERNAL_MAX_ATTEMPTS = 4;
/** DLQ consumer: park after max_retries=2 (+1 first attempt). */
const DLQ_MAX_ATTEMPTS = 3;

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
  'refresh_remote_instance',
  'reset_remote_instance_cache',
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

type ProcessOutcome = 'processed' | 'deferred' | 'skipped';

/**
 * Process a single queue message body. Shared between the main queue
 * consumers and the DLQ consumer so both run identical logic.
 *
 * Returns 'deferred' when a Fedify ordering lock is held (caller should
 * retry), 'skipped' for unrecognized bodies. Throws on processing failure.
 */
async function processMessageBody(body: Record<string, unknown>): Promise<ProcessOutcome> {
  // Ensure federation dispatchers are registered before any handler runs.
  // Legacy handlers (fetch_remote_account, fetch_remote_status) need
  // ctx.getDocumentLoader({ identifier: '__instance__' }) for signed fetches,
  // which requires the actor + key-pairs dispatcher to be set up.
  const fed = ensureFedInitialized();

  // ---- Fedify queued tasks (from WorkersMessageQueue / sendActivity) ----
  if (isFedifyMessage(body)) {
    const wmq = new WorkersMessageQueue(env.QUEUE_FEDERATION);
    const result = await measureAsync('queue.fedify.processMessage', () => wmq.processMessage(body)) as ProcessMessageResult;
    if (!result.shouldProcess) return 'deferred';
    try {
      const targetDomains = getFedifyTargetDomains(result.message);
      const inboxUrls = getFedifyInboxUrls(result.message);
      const [suspendedDomains, suspendedInboxes] = await Promise.all([
        getSuspendedDomains(env.DB, targetDomains),
        getSuspendedDeliveryInboxes(env.DB, inboxUrls),
      ]);
      const filtered = filterSuspendedFedifyTargets(
        result.message,
        suspendedDomains,
        suspendedInboxes,
      );
      if (!filtered.message) {
        console.log(JSON.stringify({
          message: 'dropped queued federation delivery to suspended domain',
          droppedTargets: filtered.droppedTargets,
          messageType: result.message?.type,
        }));
        return 'processed';
      }
      // Fedify does not export its queued Message type; the shape has already
      // been narrowed and filtered above using the runtime payload contract.
      const queuedMessage = filtered.message as any;
      debugLog('federation.fedify', 'processing queued Fedify task', {
        messageType: queuedMessage.type,
        droppedTargets: filtered.droppedTargets,
        message: queuedMessage,
      });
      await measureAsync(
        'queue.fedify.processQueuedTask',
        () => fed.processQueuedTask({ env }, queuedMessage),
        {
          messageType: queuedMessage.type,
          droppedTargets: filtered.droppedTargets,
        }
      );
      debugLog('federation.fedify', 'queued Fedify task processed', {
        messageType: queuedMessage.type,
      });
    } finally {
      await result.release?.();
    }
    return 'processed';
  }

  // ---- Legacy messages (discriminated union on `type`) ----
  if (!body || typeof body !== 'object' || !('type' in body) || typeof body.type !== 'string') {
    console.warn('[queue] Unknown message format, skipping:', JSON.stringify(body).slice(0, 200));
    return 'skipped';
  }
  // body has been validated to have a string `type` field — safe to treat as QueueMessage
  const legacyMsg = body as QueueMessage & Record<string, unknown>;
  debugLog('queue', `processing legacy message ${legacyMsg.type}`, { message: legacyMsg });
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
        case 'refresh_remote_instance':
          await handleRefreshRemoteInstance(legacyMsg);
          break;
        case 'reset_remote_instance_cache':
          await handleResetRemoteInstanceCache(legacyMsg);
          break;
        default:
          console.warn('Unknown message type:', (legacyMsg as { type: string }).type);
      }
    },
    { messageType: legacyMsg.type }
  );
  return 'processed';
}

// ---------------------------------------------------------------------------
// DLQ post-processing
// ---------------------------------------------------------------------------

interface ParkMeta {
  messageType: string;
  activityType: string | null;
  activityId: string | null;
  actor: string | null;
}

/** Best-effort triage metadata extracted from a message body for parking. */
function extractParkMeta(body: unknown): ParkMeta {
  if (body && typeof body === 'object' && '__fedify_payload__' in (body as Record<string, unknown>)) {
    const payload = (body as Record<string, unknown>).__fedify_payload__ as Record<string, unknown> | null;
    const activity = (payload?.activity ?? null) as Record<string, unknown> | null;
    return {
      messageType: `fedify:${typeof payload?.type === 'string' ? payload.type : 'unknown'}`,
      activityType: typeof activity?.type === 'string' ? activity.type : null,
      activityId: typeof activity?.id === 'string' ? activity.id : null,
      actor: typeof activity?.actor === 'string' ? activity.actor : null,
    };
  }
  const type = body && typeof body === 'object' ? (body as Record<string, unknown>).type : undefined;
  return {
    messageType: typeof type === 'string' ? type : 'unknown',
    activityType: null,
    activityId: null,
    actor: null,
  };
}

/** Persist a dead-lettered message into D1 for admin inspection/replay. */
async function parkMessage(queueName: string, msg: Message, error: string): Promise<void> {
  const meta = extractParkMeta(msg.body);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO federation_dlq_parked (
       id, queue, message_id, body, message_type, activity_type, activity_id, actor,
       error, attempts, status, parked_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'parked', ?11, ?11)`
  ).bind(
    crypto.randomUUID(),
    queueName,
    msg.id,
    JSON.stringify(msg.body),
    meta.messageType,
    meta.activityType,
    meta.activityId,
    meta.actor,
    error.slice(0, 4000),
    msg.attempts,
    now,
  ).run();
  console.error(
    `[dlq] Parked message ${msg.id} (${meta.messageType}${meta.activityType ? `/${meta.activityType}` : ''}): ${error.slice(0, 200)}`
  );
}

/**
 * Consume the federation-dlq queue: give each dead-lettered message one
 * more processing round (drains transient failures and backlogs created
 * by since-fixed bugs); park persistent failures into D1, then ack.
 */
async function consumeDlqBatch(batch: MessageBatch): Promise<void> {
  for (const msg of batch.messages) {
    const messageStart = performance.now();
    const body = msg.body as Record<string, unknown>;
    debugLog('queue.dlq', `message received on ${batch.queue}`, {
      messageId: msg.id,
      attempt: msg.attempts,
      body,
    });
    try {
      const outcome = await processMessageBody(body);
      if (outcome === 'deferred' && msg.attempts < DLQ_MAX_ATTEMPTS) {
        msg.retry({ delaySeconds: 60 });
        continue;
      }
      if (outcome === 'deferred') {
        await parkMessage(batch.queue, msg, 'ordering lock still held after DLQ retries');
        logPerformance('dlq.message.parked', performance.now() - messageStart, { messageType: 'fedify' });
      } else {
        console.log(`[dlq] Reprocessed message ${msg.id} successfully`);
        logPerformance('dlq.message.recovered', performance.now() - messageStart, {
          messageType: extractParkMeta(body).messageType,
        });
      }
      msg.ack();
    } catch (err) {
      const errText = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err);
      try {
        await parkMessage(batch.queue, msg, errText);
        logPerformance('dlq.message.parked', performance.now() - messageStart, {
          messageType: extractParkMeta(body).messageType,
          error: err instanceof Error ? err.message : String(err),
        });
        msg.ack();
      } catch (parkErr) {
        // Parking failed (e.g., D1 unavailable) — retry so the message isn't lost.
        console.error('[dlq] Failed to park message:', parkErr);
        if (msg.attempts >= DLQ_MAX_ATTEMPTS) {
          console.error(`[dlq] DROPPED unparkable message ${msg.id}:`, JSON.stringify(body).slice(0, 2000));
          msg.ack();
        } else {
          msg.retry({ delaySeconds: 60 });
        }
      }
    }
  }
}

const handler = {
  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    await ensureFedifyDebugLogging();
    ensureDebugSentryLogging();
    ensureDebugBindingLogging();

    if (batch.queue.endsWith(DLQ_QUEUE_SUFFIX)) {
      await consumeDlqBatch(batch);
      return;
    }

    const batchStart = performance.now();

    for (const msg of batch.messages) {
      const messageStart = performance.now();
      const body = msg.body as Record<string, unknown>;
      debugLog('queue', `message received on ${batch.queue}`, {
        messageId: msg.id,
        attempt: msg.attempts,
        body,
      });
      try {
        const outcome = await processMessageBody(body);
        if (outcome === 'deferred') {
          console.log('[queue] Fedify message deferred (ordering lock)');
          msg.retry();
          logPerformance('queue.message.deferred', performance.now() - messageStart, { messageType: 'fedify' });
          continue;
        }
        msg.ack();
        debugLog('queue', `message ${msg.id} ${outcome}`, {
          queue: batch.queue,
          durationMs: Math.round(performance.now() - messageStart),
        });
        logPerformance('queue.message.processed', performance.now() - messageStart, {
          messageType: isFedifyMessage(body) ? 'fedify' : 'legacy',
          ...(typeof body?.type === 'string' ? { legacyType: body.type } : {}),
        });
      } catch (err) {
        const bodyType =
          body && typeof body === 'object' && 'type' in body ? body.type : 'fedify-task';
        logPerformance('queue.message.error', performance.now() - messageStart, {
          messageType: bodyType,
          error: err instanceof Error ? err.message : String(err),
          attempt: msg.attempts,
        });
        console.error(`Queue handler error for ${bodyType} (attempt ${msg.attempts}):`, err);

        if (batch.queue.endsWith(INTERNAL_QUEUE_SUFFIX)) {
          // The internal queue has no DLQ — drop poison messages at max
          // attempts to prevent an infinite retry loop.
          if (msg.attempts >= INTERNAL_MAX_ATTEMPTS) {
            console.error(`[queue] DROPPED after ${msg.attempts} attempts: ${bodyType}`, JSON.stringify(msg.body));
            msg.ack();
          } else {
            msg.retry();
          }
        } else {
          // The federation queue is DLQ-backed: keep retrying so Cloudflare
          // moves the message to the DLQ once max_retries is exhausted.
          msg.retry();
        }
      }
    }

    const batchDuration = performance.now() - batchStart;
    logPerformance('queue.batch.complete', batchDuration, {
      messageCount: batch.messages.length
    });
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (workerEnv: Env) => ({
    // SENTRY_DSN is an optional Cloudflare secret; Sentry is disabled when it is unset.
    dsn: workerEnv.SENTRY_DSN || undefined,
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  handler,
);
