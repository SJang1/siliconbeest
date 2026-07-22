/** Cloudflare currently caps each Queue producer at 5,000 messages/second. */
export const INBOX_QUEUE_LANES = 8;

type QueueBinding = Queue<unknown>;
type EnqueueOptions = {
  readonly orderingKey?: string;
  readonly delay?: { total(unit: 'seconds'): number };
};
type ListenOptions = { signal?: AbortSignal };

function stableHash(value: string): number {
  // FNV-1a, kept deliberately small and deterministic across Worker isolates.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof Reflect.get(value, 'href') === 'string') {
    return Reflect.get(value, 'href') as string;
  }
  return null;
}

/**
 * Choose a stable lane for an inbound Fedify task.
 *
 * Ordering keys take precedence. Otherwise object/activity identity is used,
 * then actor identity. This keeps Create/Update/Delete for the same object on
 * one Queue while distributing unrelated ActivityPub traffic across lanes.
 */
export function inboxLaneKey(
  message: unknown,
  options?: EnqueueOptions,
): string {
  if (options?.orderingKey) return `ordering:${options.orderingKey}`;
  if (!message || typeof message !== 'object') return 'unknown';

  const activity = Reflect.get(message, 'activity');
  if (activity && typeof activity === 'object') {
    const object = Reflect.get(activity, 'object');
    const objectId = stringValue(object)
      ?? (object && typeof object === 'object' ? stringValue(Reflect.get(object, 'id')) : null);
    const activityId = stringValue(Reflect.get(activity, 'id'));
    const actor = stringValue(Reflect.get(activity, 'actor'));
    return objectId
      ? `object:${objectId}`
      : activityId
        ? `activity:${activityId}`
        : actor
          ? `actor:${actor}`
          : 'unknown';
  }

  return stringValue(Reflect.get(message, 'id')) ?? 'unknown';
}

export function inboxLaneIndex(
  message: unknown,
  options?: EnqueueOptions,
  laneCount = INBOX_QUEUE_LANES,
): number {
  if (!Number.isInteger(laneCount) || laneCount < 1) {
    throw new RangeError('laneCount must be a positive integer');
  }
  return stableHash(inboxLaneKey(message, options)) % laneCount;
}

export class StripedInboxMessageQueue {
  readonly nativeRetrial = true;
  readonly #lanes: QueueBinding[];

  constructor(bindings: readonly QueueBinding[]) {
    if (bindings.length < 1) throw new Error('At least one inbox Queue lane is required');
    this.#lanes = [...bindings];
  }

  async enqueue(message: unknown, options?: EnqueueOptions): Promise<void> {
    const lane = inboxLaneIndex(message, options, this.#lanes.length);
    await this.#lanes[lane]!.send({
      __fedify_ordering_key__: options?.orderingKey,
      __fedify_payload__: message,
    }, {
      contentType: 'json',
      delaySeconds: options?.delay?.total('seconds') ?? 0,
    });
  }

  async enqueueMany(
    messages: readonly unknown[],
    options?: EnqueueOptions,
  ): Promise<void> {
    const groups = new Map<number, unknown[]>();
    for (const message of messages) {
      const lane = inboxLaneIndex(message, options, this.#lanes.length);
      const group = groups.get(lane) ?? [];
      group.push(message);
      groups.set(lane, group);
    }
    // Inbound HTTP handling normally enqueues one task. Keep this uncommon
    // bulk path sequential per lane so a 96 KiB activity can never make a
    // Cloudflare sendBatch request exceed its aggregate byte limit.
    for (const [lane, laneMessages] of groups) {
      for (const message of laneMessages) {
        await this.#lanes[lane]!.send({
          __fedify_ordering_key__: options?.orderingKey,
          __fedify_payload__: message,
        }, {
          contentType: 'json',
          delaySeconds: options?.delay?.total('seconds') ?? 0,
        });
      }
    }
  }

  async listen(
    _handler: (message: unknown) => Promise<void> | void,
    _options?: ListenOptions,
  ): Promise<void> {
    throw new Error('Cloudflare Queues are consumed by the Worker queue handler');
  }
}

export function inboxQueueBindings(env: Env): QueueBinding[] {
  return [
    env.QUEUE_INBOX_0,
    env.QUEUE_INBOX_1,
    env.QUEUE_INBOX_2,
    env.QUEUE_INBOX_3,
    env.QUEUE_INBOX_4,
    env.QUEUE_INBOX_5,
    env.QUEUE_INBOX_6,
    env.QUEUE_INBOX_7,
  ];
}
