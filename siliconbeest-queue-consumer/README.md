# SiliconBeest Queue Consumer

Asynchronous job processor for SiliconBeest. This Cloudflare Worker consumes messages from two Cloudflare Queues (federation and internal) and dispatches each message to the appropriate handler.

---

## What It Does

- Delivers ActivityPub activities to remote servers with HTTP Signatures, Linked Data Signatures, and Object Integrity Proofs.
- Fans out activity deliveries to multiple remote inboxes (grouped by shared inbox).
- Forwards activities to remote servers with original signature preservation.
- Fans out new statuses to follower home timelines and emits streaming events.
- Creates notifications for mentions, follows, favourites, boosts, and reactions, with web push and streaming.
- Processes uploaded media (thumbnails, metadata extraction) in R2.
- Fetches and caches remote account profiles from federated servers.
- Fetches and caches remote statuses/notes from federated servers.
- Fetches OpenGraph metadata for URL preview cards.
- Sends Web Push notifications to subscribed client endpoints.

---

## Message Types

All messages use a discriminated union on the `type` field. The consumer reads `msg.body.type` and routes to the matching handler.

| Type                       | Queue      | Handler                       | Description                                                          |
| -------------------------- | ---------- | ----------------------------- | -------------------------------------------------------------------- |
| `deliver_activity`         | federation | `handleDeliverActivity`       | Sign and POST an ActivityPub activity to a single remote inbox (HTTP Sig + LD Sig + OIP) |
| `deliver_activity_fanout`  | federation | `handleDeliverActivityFanout` | Fan out an activity delivery to multiple remote inboxes              |
| `forward_activity`         | federation | `handleForwardActivity`       | Forward an activity to a remote inbox preserving the original signature |
| `fetch_remote_account`     | federation | `handleFetchRemoteAccount`    | Fetch and cache an actor profile from a remote server                |
| `fetch_remote_status`      | federation | `handleFetchRemoteStatus`     | Fetch and cache a status/note from a remote server                   |
| `fetch_preview_card`       | internal   | `handleFetchPreviewCard`      | Fetch OpenGraph metadata for a URL and attach as a preview card      |
| `timeline_fanout`          | internal   | `handleTimelineFanout`        | Insert a status into each follower's home timeline + emit streaming events |
| `create_notification`      | internal   | `handleCreateNotification`    | Write a notification record, trigger web push + streaming            |
| `process_media`            | internal   | `handleProcessMedia`          | Process an uploaded media file (resize, extract metadata) in R2      |
| `send_web_push`            | internal   | `handleSendWebPush`           | Deliver a Web Push notification to a subscribed endpoint             |
| `update_trends`            | internal   | (inline)                      | Update trending tags and statuses                                    |

Additional message types defined in the queue schema but not yet actively handled:

| Type                       | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `update_instance_info`     | Refresh cached instance metadata for a remote domain         |
| `deliver_report`           | Forward a report to the target instance                      |
| `cleanup_expired_tokens`   | Clean up expired OAuth tokens                                |

---

## Handlers

Source files live in `src/handlers/`:

```
src/
  index.ts                    # Queue batch consumer, message router
  env.ts                      # Env type definitions
  handlers/
    deliverActivity.ts        # HTTP Signature + LD Signature + OIP + POST to remote inbox
    deliverActivityFanout.ts  # Expand follower list, group by shared inbox, enqueue individual deliveries
    forwardActivity.ts        # Forward activity with original signature preservation
    timelineFanout.ts         # Write timeline entries for local followers + streaming events
    createNotification.ts     # Persist notification, trigger web push + streaming
    processMedia.ts           # R2 media processing pipeline
    fetchRemoteAccount.ts     # GET remote actor, upsert local cache
    fetchRemoteStatus.ts      # GET remote note/article, upsert local cache
    fetchPreviewCard.ts       # Fetch OpenGraph metadata for URL preview cards
    sendWebPush.ts            # Construct and send Web Push payload
    integrityProofs.ts        # Object Integrity Proof (Ed25519) utilities
    ldSignatures.ts           # Linked Data Signature utilities
  shared/
    types/
      queue.ts                # QueueMessage discriminated union type
    webpush.ts                # Web Push shared utilities
```

---

## Configuration

The consumer is configured in `wrangler.jsonc`:

### Bindings

| Binding            | Service | Purpose                                                      |
| ------------------ | ------- | ------------------------------------------------------------ |
| `DB`               | D1      | Read/write database for notifications, timelines, account cache |
| `MEDIA_BUCKET`     | R2      | Read/write media files during processing                     |
| `CACHE`            | KV      | Cache remote actor/status lookups                            |
| `QUEUE_FEDERATION` | Queues  | Re-enqueue federation jobs (fanout -> individual deliveries) |
| `QUEUE_INTERNAL`   | Queues  | Re-enqueue internal jobs                                     |
| `WORKER`           | Service | Service binding to main worker (for Durable Object access)  |

### Queue Consumer Settings

| Queue                      | Max Retries | Dead Letter Queue              |
| -------------------------- | ----------- | ------------------------------ |
| `siliconbeest-federation`  | 5           | `siliconbeest-federation-dlq`  |
| `siliconbeest-internal`    | 3           | (none)                         |

---

## How Federation Delivery Works

1. The main worker creates a status or processes an interaction. It enqueues a `deliver_activity_fanout` message to the federation queue.
2. The consumer picks up the fanout message, queries the database for all remote followers, groups them by shared inbox, and enqueues one `deliver_activity` message per unique inbox.
3. Each `deliver_activity` handler:
   - Constructs the ActivityPub JSON-LD payload
   - Signs it with the actor's RSA private key using HTTP Signatures (draft-cavage)
   - Attaches Linked Data Signatures for relay forwarding
   - Attaches Object Integrity Proofs (Ed25519) when applicable
   - POSTs it to the remote inbox
4. On success, `msg.ack()` removes the message from the queue.
5. On failure, `msg.retry()` re-enqueues the message for another attempt (up to the max retry count).

### Activity Forwarding

When a forwarded activity is received (e.g., a reply to a local post from a remote follower), the consumer can forward the activity to other followers while preserving the original HTTP signature via the `forward_activity` message type.

---

## Retry and Dead Letter Queue Behavior

- **Federation queue**: Messages are retried up to **5 times**. After all retries are exhausted, the message is moved to the `siliconbeest-federation-dlq` dead letter queue for manual inspection.
- **Internal queue**: Messages are retried up to **3 times**. Failed messages are dropped after exhausting retries (no DLQ configured).
- Each handler catches errors individually: on success it calls `msg.ack()`, on error it calls `msg.retry()` and logs the error.

---

## Local Development

```bash
npm install
npm run dev
```

Note: Queue consumption in local development requires `wrangler dev` to be running for both the main worker and the consumer simultaneously. Messages enqueued by the worker will be delivered to the consumer in the local environment.

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
