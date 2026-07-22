import { describe, expect, it, vi } from 'vitest';
import {
  inboxLaneIndex,
  StripedInboxMessageQueue,
} from '../../packages/shared/federation/stripedInboxQueue';

function activity(id: string, object: string, actor = 'https://remote.example/users/a') {
  return { type: 'inbox', activity: { id, object, actor } };
}

describe('StripedInboxMessageQueue', () => {
  it('keeps mutations for the same object on one lane', () => {
    const create = activity('https://remote.example/a/1', 'https://remote.example/o/1');
    const update = activity('https://remote.example/a/2', 'https://remote.example/o/1');
    expect(inboxLaneIndex(create)).toBe(inboxLaneIndex(update));
  });

  it('gives an explicit ordering key precedence over payload identity', () => {
    const first = activity('a', 'object-a');
    const second = activity('b', 'object-b');
    expect(inboxLaneIndex(first, { orderingKey: 'same' }))
      .toBe(inboxLaneIndex(second, { orderingKey: 'same' }));
  });

  it('wraps messages in the Fedify Cloudflare Queue envelope', async () => {
    const lanes = Array.from({ length: 8 }, () => ({ send: vi.fn() }));
    const queue = new StripedInboxMessageQueue(lanes as unknown as Queue<unknown>[]);
    const message = activity('activity-1', 'object-1');
    const expectedLane = inboxLaneIndex(message, { orderingKey: 'object-1' });

    await queue.enqueue(message, { orderingKey: 'object-1' });

    expect(lanes[expectedLane]!.send).toHaveBeenCalledWith({
      __fedify_ordering_key__: 'object-1',
      __fedify_payload__: message,
    }, {
      contentType: 'json',
      delaySeconds: 0,
    });
    expect(lanes.reduce((count, lane) => count + lane.send.mock.calls.length, 0)).toBe(1);
  });
});
