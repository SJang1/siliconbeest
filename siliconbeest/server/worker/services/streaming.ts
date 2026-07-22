/**
 * Streaming service helper.
 *
 * Used by the queue consumer (and other internal callers) to push events
 * into a user's StreamingDO instance, which then broadcasts to all
 * connected WebSocket clients.
 */

import { env } from 'cloudflare:workers';
import type { StreamEventPayload } from '../internal-contract';
import {
  resolveStreamingTopology,
  streamingEventBytes,
} from '../../../../packages/shared/utils/streamingTopology';

export type { StreamEventPayload } from '../internal-contract';

export async function sendStreamEventToDurableObject(
  userId: string,
  event: StreamEventPayload,
): Promise<void> {
  const streamingDo = env.STREAMING_DO;
  if (!streamingDo) {
    throw new Error('Streaming requires the STREAMING_DO binding');
  }

  const topology = resolveStreamingTopology(env);
  if (streamingEventBytes(event) > topology.eventMaxBytes) {
    console.warn(JSON.stringify({
      message: 'stream event dropped: payload exceeds bounded real-time envelope',
      event: event.event,
      maxBytes: topology.eventMaxBytes,
    }));
    return;
  }

  if (userId === '__public__') {
    const fanoutDo = env.STREAM_FANOUT_DO;
    if (!fanoutDo) {
      throw new Error('Public streaming requires the STREAM_FANOUT_DO binding');
    }
    await Promise.all(Array.from({ length: topology.branchFactor }, (_, nodeIndex) =>
      fanoutDo
        .getByName(`public:depth:${topology.depth - 1}:node:${nodeIndex}`)
        .publish(event, nodeIndex, topology.depth - 1, topology.branchFactor),
    ));
    return;
  }

  const doId = streamingDo.idFromName(userId);
  const stub = streamingDo.get(doId);

  await stub.sendEvent(event);
}

/**
 * Send an event to a user's StreamingDO instance.
 *
 * @param userId       The user ID (used as DO name)
 * @param event        The event to broadcast
 */
export async function sendStreamEvent(
  userId: string,
  event: StreamEventPayload,
): Promise<void> {
  // The main Worker owns StreamingDO and can access it directly. Shared
  // federation processors also run inside the queue consumer, which reaches
  // the owning Worker through its named INTERNAL_CONNECTION_MAIN service binding instead.
  if (!env.STREAMING_DO) {
    if (!env.INTERNAL_CONNECTION_MAIN) {
      throw new Error(
        'Streaming requires either STREAMING_DO or INTERNAL_CONNECTION_MAIN binding',
      );
    }

    await env.INTERNAL_CONNECTION_MAIN.sendStreamEvent(userId, event);
    return;
  }

  await sendStreamEventToDurableObject(userId, event);
}

/**
 * Broadcast a `reaction` event for a status whose emoji reactions changed.
 *
 * Clients receive `{ status_id }` and refetch that status's reactions if
 * they render it. Delivered to the users whose home timelines can show the
 * status (local author + their local followers) and, for public statuses,
 * to the shared __public__ instance for the public/local timelines —
 * mirroring how timelineFanout targets `update` events.
 *
 * Best-effort: streaming failures never fail the reaction itself.
 */
export async function broadcastReactionEvent(statusId: string): Promise<void> {
  try {
    const status = await env.DB_META_C000.prepare(
      `SELECT s.account_id, s.visibility, a.domain AS author_domain
       FROM statuses s JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ?1`,
    ).bind(statusId).first<{ account_id: string; visibility: string | null; author_domain: string | null }>();
    if (!status) return;

    const payload = JSON.stringify({ status_id: statusId });

    const { results } = await env.DB_META_C000.prepare(
      `SELECT u.id FROM users u WHERE u.account_id = ?1
       UNION
       SELECT u.id FROM follows f JOIN users u ON u.account_id = f.account_id
       WHERE f.target_account_id = ?1`,
    ).bind(status.account_id).all<{ id: string }>();

    const targets = (results ?? []).map((result) => result.id);
    for (let offset = 0; offset < targets.length; offset += 5) {
      await Promise.allSettled(targets.slice(offset, offset + 5).map((target) =>
        sendStreamEvent(target, { event: 'reaction', payload, stream: ['user'] }),
      ));
    }

    if ((status.visibility ?? 'public') === 'public') {
      await sendStreamEvent('__public__', {
        event: 'reaction',
        payload,
        stream: status.author_domain ? ['public'] : ['public', 'public:local'],
      }).catch(() => {});
    }
  } catch {
    // Best-effort only
  }
}
