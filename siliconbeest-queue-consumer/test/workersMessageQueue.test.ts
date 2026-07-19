import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkersMessageQueue } from '@fedify/cfworkers';

describe('Fedify WorkersMessageQueue', () => {
  const send = vi.fn();
  const sendBatch = vi.fn();
  const queue = { send, sendBatch } as unknown as Queue;

  beforeEach(() => {
    send.mockReset();
    sendBatch.mockReset();
    send.mockResolvedValue(undefined);
    sendBatch.mockResolvedValue(undefined);
  });

  it('splits batches at Cloudflare\'s 100-message limit', async () => {
    const messageQueue = new WorkersMessageQueue(queue);
    const messages = Array.from({ length: 101 }, (_, id) => ({ id }));

    await messageQueue.enqueueMany(messages);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls.map(([requests]) => requests.length)).toEqual([100, 1]);
  });

  it.each([
    ['single-byte ASCII', 'a', 80_000],
    ['multi-byte Unicode', '🙂', 20_000],
  ])(
    'splits %s payloads by UTF-8 byte size before reaching 256 KB',
    async (_label, character, repetitions) => {
      const messageQueue = new WorkersMessageQueue(queue);
      const messages = Array.from({ length: 3 }, (_, id) => ({
        id,
        // Each content value is 80,000 UTF-8 bytes regardless of whether its
        // source characters use one-byte or multi-byte encodings.
        content: character.repeat(repetitions),
      }));

      await messageQueue.enqueueMany(messages);

      expect(sendBatch).toHaveBeenCalledTimes(2);
      expect(sendBatch.mock.calls.map(([requests]) => requests.length)).toEqual([2, 1]);

      const queuedIds = sendBatch.mock.calls.flatMap(([requests]) =>
        requests.map((request: MessageSendRequest<Record<string, unknown>>) => {
          const envelope = request.body as { __fedify_payload__: { id: number } };
          return envelope.__fedify_payload__.id;
        }),
      );
      expect(queuedIds).toEqual([0, 1, 2]);
    },
  );

  it('does not enqueue an empty batch', async () => {
    const messageQueue = new WorkersMessageQueue(queue);

    await messageQueue.enqueueMany([]);

    expect(sendBatch).not.toHaveBeenCalled();
  });
});
