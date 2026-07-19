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
});
