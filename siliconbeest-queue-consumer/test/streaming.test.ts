import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    DB_META_C000: {},
    INTERNAL_CONNECTION_MAIN: { sendStreamEvent: vi.fn() },
  },
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));

import { sendStreamEvent } from '../../siliconbeest/server/worker/services/streaming';

beforeEach(() => {
  mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockReset();
  delete (mocks.env as Record<string, unknown>).STREAMING_DO;
});

describe('streaming transport', () => {
  it('uses the Durable Object binding directly in the main Worker', async () => {
    const stub = { sendEvent: vi.fn().mockResolvedValue(undefined) };
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
    expect(stub.sendEvent).toHaveBeenCalledWith({
      event: 'update',
      payload: '{}',
      stream: ['user'],
    });
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
  });

  it('routes events through the main Worker service binding', async () => {
    mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockResolvedValue(undefined);

    const event = {
      event: 'reaction',
      payload: JSON.stringify({ status_id: 'status-1' }),
      stream: ['user'],
    };
    await sendStreamEvent('user-1', event);

    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledWith('user-1', event);
  });

  it('propagates a failed main Worker RPC', async () => {
    mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockRejectedValue(new Error('Streaming RPC failed'));

    await expect(sendStreamEvent('user-1', {
      event: 'reaction',
      payload: '{}',
    })).rejects.toThrow('Streaming RPC failed');
  });
});
