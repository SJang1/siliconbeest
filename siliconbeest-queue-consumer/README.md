# SiliconBeest Queue Consumer

Asynchronous job processor for SiliconBeest. This Cloudflare Worker consumes messages from two Cloudflare Queues (federation and internal) and dispatches each message to the appropriate handler.

> Version **0.1.0**

---

## What It Does

- Delivers ActivityPub activities to remote servers (federation).
- Fans out new statuses to follower home timelines.
- Creates notifications for mentions, follows, favourites, and boosts.
- Processes uploaded media (thumbnails, metadata extraction).
- Fetches remote account and status data from federated servers.
- Sends Web Push notifications to subscribed clients.

---

## Message Types

All messages use a discriminated union on the `type` field. The consumer reads `msg.body.type` and routes to the matching handler.

| Type                       | Queue      | Handler                       | Description                                                     |
| -------------------------- | ---------- | ----------------------------- | --------------------------------------------------------------- |
| `deliver_activity`         | federation | `handleDeliverActivity`       | Sign and POST an ActivityPub activity to a single remote inbox  |
| `deliver_activity_fanout`  | federation | `handleDeliverActivityFanout` | Fan out an activity delivery to multiple remote inboxes         |
| `timeline_fanout`          | internal   | `handleTimelineFanout`        | Insert a status into each follower's home timeline              |
| `create_notification`      | internal   | `handleCreateNotification`    | Write a notification record and trigger push if subscribed      |
| `process_media`            | internal   | `handleProcessMedia`          | Process an uploaded media file (resize, extract metadata) in R2 |
| `fetch_remote_account`     | federation | `handleFetchRemoteAccount`    | Fetch and cache an actor profile from a remote server           |
| `fetch_remote_status`      | federation | `handleFetchRemoteStatus`     | Fetch and cache a status/note from a remote server              |
| `send_web_push`            | internal   | `handleSendWebPush`           | Deliver a Web Push notification to a subscribed endpoint        |

---

## Handlers

Source files live in `src/handlers/`:

```
src/
  index.ts                    # Queue batch consumer, message router
  env.ts                      # Env type definitions
  handlers/
    deliverActivity.ts        # HTTP Signature + POST to remote inbox
    deliverActivityFanout.ts  # Expand follower list, enqueue individual deliveries
    timelineFanout.ts         # Write timeline entries for local followers
    createNotification.ts     # Persist notification, trigger push
    processMedia.ts           # R2 media processing pipeline
    fetchRemoteAccount.ts     # GET remote actor, upsert local cache
    fetchRemoteStatus.ts      # GET remote note/article, upsert local cache
    sendWebPush.ts            # Construct and send Web Push payload
  shared/
    types/
      queue.ts                # QueueMessage discriminated union type
```

---

## Configuration

The consumer is configured in `wrangler.jsonc`:

### Bindings

| Binding            | Service | Purpose                                  |
| ------------------ | ------- | ---------------------------------------- |
| `DB`               | D1      | Read/write database for notifications, timelines, account cache |
| `MEDIA_BUCKET`     | R2      | Read/write media files during processing |
| `CACHE`            | KV      | Cache remote actor/status lookups        |
| `QUEUE_FEDERATION` | Queues  | Re-enqueue federation jobs (fanout)      |
| `QUEUE_INTERNAL`   | Queues  | Re-enqueue internal jobs                 |
| `WORKER`           | Service | Service binding to main worker (for Durable Object access) |

### Queue Consumer Settings

| Queue                      | Max Retries | Dead Letter Queue              |
| -------------------------- | ----------- | ------------------------------ |
| `siliconbeest-federation`  | 5           | `siliconbeest-federation-dlq`  |
| `siliconbeest-internal`    | 3           | (none)                         |

---

## How Federation Delivery Works

1. The main worker creates a status or processes an interaction. It enqueues a `deliver_activity_fanout` message to the federation queue.
2. The consumer picks up the fanout message, queries the database for all remote followers, groups them by shared inbox, and enqueues one `deliver_activity` message per unique inbox.
3. Each `deliver_activity` handler constructs the ActivityPub JSON-LD payload, signs it with the actor's RSA private key using HTTP Signatures, and POSTs it to the remote inbox.
4. On success, `msg.ack()` removes the message from the queue.
5. On failure, `msg.retry()` re-enqueues the message for another attempt (up to the max retry count).

---

## Retry and Dead Letter Queue Behavior

- **Federation queue**: Messages are retried up to **5 times**. After all retries are exhausted, the message is moved to the `siliconbeest-federation-dlq` dead letter queue for manual inspection.
- **Internal queue**: Messages are retried up to **3 times**. Failed messages are dropped after exhausting retries (no DLQ configured).
- Each handler catches errors individually: on success it calls `msg.ack()`, on error it calls `msg.retry()` and logs the error.

---

## How to Add New Handlers

1. Define your new message type in `src/shared/types/queue.ts`:

```typescript
export type QueueMessage =
  | { type: 'deliver_activity'; /* ... */ }
  | { type: 'my_new_job'; payload: MyPayload }
  // ...
```

2. Create a handler file in `src/handlers/`:

```typescript
// src/handlers/myNewJob.ts
import type { Env } from '../env';
import type { MyNewJobMessage } from '../shared/types/queue';

export async function handleMyNewJob(
  msg: MyNewJobMessage,
  env: Env
): Promise<void> {
  // your logic here
}
```

3. Add the case to the switch in `src/index.ts`:

```typescript
case 'my_new_job':
  await handleMyNewJob(msg.body, env);
  break;
```

4. In the main worker, enqueue messages using the appropriate queue binding:

```typescript
await env.QUEUE_INTERNAL.send({ type: 'my_new_job', payload: { ... } });
```

---

## Local Development

```bash
npm install
npm run dev
```

Note: Queue consumption in local development requires `wrangler dev` to be running for both the main worker and the consumer simultaneously. Messages enqueued by the worker will be delivered to the consumer in the local environment.
