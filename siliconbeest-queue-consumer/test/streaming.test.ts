import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    DB: {},
    WORKER: { fetch: vi.fn() },
  },
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));

import { sendStreamEvent } from '../../siliconbeest/server/worker/services/streaming';

beforeEach(() => {
  mocks.env.WORKER.fetch.mockReset();
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
    expect(mocks.env.WORKER.fetch).not.toHaveBeenCalled();
  });

  it('routes events through the main Worker service binding', async () => {
    mocks.env.WORKER.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await sendStreamEvent('user-1', {
      event: 'reaction',
      payload: JSON.stringify({ status_id: 'status-1' }),
      stream: ['user'],
    });

    expect(mocks.env.WORKER.fetch).toHaveBeenCalledTimes(1);
    const request = mocks.env.WORKER.fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe('http://internal/internal/stream-event');
    expect(request.method).toBe('POST');
    await expect(request.json()).resolves.toEqual({
      userId: 'user-1',
      event: 'reaction',
      payload: JSON.stringify({ status_id: 'status-1' }),
      stream: ['user'],
    });
  });

  it('reports a failed main Worker response', async () => {
    mocks.env.WORKER.fetch.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(sendStreamEvent('user-1', {
      event: 'reaction',
      payload: '{}',
    })).rejects.toThrow('Streaming service returned 503');
  });
});
