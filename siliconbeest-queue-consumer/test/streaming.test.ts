import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    DB: {},
    INTERNAL: { sendStreamEvent: vi.fn() },
  },
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));

import { sendStreamEvent } from '../../siliconbeest/server/worker/services/streaming';

beforeEach(() => {
  mocks.env.INTERNAL.sendStreamEvent.mockReset();
  delete (mocks.env as Record<string, unknown>).STREAMING_DO;
});

describe('streaming transport', () => {
  it('uses the Durable Object binding directly in the main Worker', async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) };
    const idFromName = vi.fn().mockReturnValue('do-id');
    const get = vi.fn().mockReturnValue(stub);
    Object.assign(mocks.env, { STREAMING_DO: { idFromName, get } });

    await sendStreamEvent('user-1', {
      event: 'update',
      payload: '{}',
      stream: ['user'],
    });

    expect(idFromName).toHaveBeenCalledWith('user-1');
    expect(get).toHaveBeenCalledWith('do-id');
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL.sendStreamEvent).not.toHaveBeenCalled();
  });

  it('routes events through the main Worker service binding', async () => {
    mocks.env.INTERNAL.sendStreamEvent.mockResolvedValue(undefined);

    const event = {
      event: 'reaction',
      payload: JSON.stringify({ status_id: 'status-1' }),
      stream: ['user'],
    };
    await sendStreamEvent('user-1', event);

    expect(mocks.env.INTERNAL.sendStreamEvent).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL.sendStreamEvent).toHaveBeenCalledWith('user-1', event);
  });

  it('propagates a failed main Worker RPC', async () => {
    mocks.env.INTERNAL.sendStreamEvent.mockRejectedValue(new Error('Streaming RPC failed'));

    await expect(sendStreamEvent('user-1', {
      event: 'reaction',
      payload: '{}',
    })).rejects.toThrow('Streaming RPC failed');
  });
});
