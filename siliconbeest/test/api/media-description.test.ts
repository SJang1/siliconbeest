import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pollMediaDescription } from '@/api/mastodon/media';
import type { MediaAttachment } from '@/types/mastodon';

function media(
  status: NonNullable<MediaAttachment['description_generation_status']>,
  description: string | null = null,
): MediaAttachment {
  return {
    id: 'media-1',
    type: 'image',
    url: 'https://cdn.example/media-1.png',
    preview_url: null,
    remote_url: null,
    meta: null,
    description,
    description_generation_status: status,
    blurhash: null,
  };
}

describe('media description polling', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops polling when the background description is complete', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(media('pending')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(media('complete', 'A red flower.')), {
        status: 200,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollMediaDescription('media-1', 'token-1', {
      maxAttempts: 5,
      intervalMs: 0,
    });

    expect(result?.description).toBe('A red flower.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds polling when the server remains pending', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(media('pending')), {
      status: 200,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollMediaDescription('media-1', 'token-1', {
      maxAttempts: 3,
      intervalMs: 0,
    });

    expect(result?.description_generation_status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times out when a media status request never responds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = pollMediaDescription('media-1', 'token-1', {
      maxAttempts: 5,
      intervalMs: 0,
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow('Media description polling timed out');
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
