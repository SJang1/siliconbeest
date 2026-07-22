import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const ALLOWED_STREAMS_HEADER = 'X-Siliconbeest-Allowed-Streams';
const STREAMING_REQUEST_URL = 'https://test.siliconbeest.local/api/v1/streaming';

describe('StreamingDO subscription permissions', () => {
  beforeAll(async () => {
    // First DO call evaluates the whole worker bundle; pay that cold-start
    // cost here so it doesn't count against per-test timeouts under load.
    const stub = env.STREAMING_DO.getByName('warm-up');
    await stub.fetch(STREAMING_REQUEST_URL);
  }, 30_000);

  it('rejects an initial stream outside the endpoint-authorized channels', async () => {
    const stub = env.STREAMING_DO.getByName('initial-stream-scope');
    const response = await stub.fetch(`${STREAMING_REQUEST_URL}?stream=user:notification`, {
      headers: {
        Upgrade: 'websocket',
        [ALLOWED_STREAMS_HEADER]: JSON.stringify(['direct']),
      },
    });

    expect(response.status).toBe(403);
  }, 15_000);

  it('rejects a later subscription outside the endpoint-authorized channels', async () => {
    const stub = env.STREAMING_DO.getByName('subscription-scope');
    const response = await stub.fetch(`${STREAMING_REQUEST_URL}?stream=direct`, {
      headers: {
        Upgrade: 'websocket',
        [ALLOWED_STREAMS_HEADER]: JSON.stringify(['direct']),
      },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error('Expected a WebSocket response');
    socket.accept();

    const message = new Promise<MessageEvent>((resolve) => {
      socket.addEventListener('message', resolve, { once: true });
    });
    socket.send(JSON.stringify({ type: 'subscribe', stream: 'user:notification' }));

    await expect(message).resolves.toMatchObject({
      data: JSON.stringify({
        error: 'This action is outside the authorized scopes',
        status: 403,
      }),
    });
    socket.close(1000, 'test complete');
  }, 15_000);

  it('coalesces paused update bodies into a count-only event', async () => {
    const stub = env.STREAMING_DO.getByName('count-only');
    const response = await stub.fetch(`${STREAMING_REQUEST_URL}?stream=public`, {
      headers: {
        Upgrade: 'websocket',
        [ALLOWED_STREAMS_HEADER]: JSON.stringify(['public']),
      },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error('Expected a WebSocket response');
    socket.accept();
    socket.send(JSON.stringify({ type: 'pause_content', stream: 'public' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received = new Promise<MessageEvent>((resolve) => {
      socket.addEventListener('message', resolve, { once: true });
    });
    await stub.sendEvent({
      event: 'update',
      payload: JSON.stringify({ id: 'must-not-be-delivered' }),
      stream: ['public'],
    });

    const message = await received;
    const envelope = JSON.parse(String(message.data)) as { event: string; payload: string };
    expect(envelope.event).toBe('new_items');
    expect(JSON.parse(envelope.payload)).toEqual({ count: 1, streams: { public: 1 } });
    expect(String(message.data)).not.toContain('must-not-be-delivered');
    socket.close(1000, 'test complete');
  }, 15_000);
});
