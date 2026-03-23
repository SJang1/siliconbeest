/**
 * SiliconBeest Queue Consumer
 *
 * Cloudflare Worker that consumes messages from the federation
 * and internal queues. Dispatches each message to the appropriate
 * handler based on the discriminated union type field.
 */

import type { Env } from './env';
import type { QueueMessage } from './shared/types/queue';
import { handleDeliverActivity } from './handlers/deliverActivity';
import { handleDeliverActivityFanout } from './handlers/deliverActivityFanout';
import { handleTimelineFanout } from './handlers/timelineFanout';
import { handleCreateNotification } from './handlers/createNotification';
import { handleProcessMedia } from './handlers/processMedia';
import { handleFetchRemoteAccount } from './handlers/fetchRemoteAccount';
import { handleFetchRemoteStatus } from './handlers/fetchRemoteStatus';
import { handleSendWebPush } from './handlers/sendWebPush';

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        switch (msg.body.type) {
          case 'deliver_activity':
            await handleDeliverActivity(msg.body, env);
            break;
          case 'deliver_activity_fanout':
            await handleDeliverActivityFanout(msg.body, env);
            break;
          case 'timeline_fanout':
            await handleTimelineFanout(msg.body, env);
            break;
          case 'create_notification':
            await handleCreateNotification(msg.body, env);
            break;
          case 'process_media':
            await handleProcessMedia(msg.body, env);
            break;
          case 'fetch_remote_account':
            await handleFetchRemoteAccount(msg.body, env);
            break;
          case 'fetch_remote_status':
            await handleFetchRemoteStatus(msg.body, env);
            break;
          case 'send_web_push':
            await handleSendWebPush(msg.body, env);
            break;
          default:
            console.warn('Unknown message type:', (msg.body as any).type);
        }
        msg.ack();
      } catch (err) {
        console.error(`Queue handler error for ${msg.body.type}:`, err);
        msg.retry();
      }
    }
  },
};
