import { describe, expect, it, vi } from 'vitest';
import { UrlError } from '@fedify/vocab-runtime';
import { withCloudflareCnameFallback } from '../../server/worker/federation/documentLoader';

function dnsResponse(answers: Array<{ type: number; data: string }>): Response {
  return Response.json({ Status: 0, Answer: answers });
}

describe('Cloudflare CNAME document loader fallback', () => {
  it('resolves a public CNAME false positive and loads the ActivityPub JSON', async () => {
    const primary = vi.fn(async () => {
      throw new UrlError('Invalid or private address: app-host.example.net');
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.hostname === 'cloudflare-dns.com') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        if (name === 'blog.example' && type === 'A') {
          return dnsResponse([{ type: 5, data: 'app-host.example.net.' }]);
        }
        if (name === 'app-host.example.net' && type === 'A') {
          return dnsResponse([{ type: 1, data: '93.184.216.34' }]);
        }
        return dnsResponse([]);
      }
      return Response.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: 'https://blog.example/ap/articles/1',
        type: 'Article',
      }, { headers: { 'Content-Type': 'application/activity+json' } });
    });

    const loader = withCloudflareCnameFallback(primary, fetcher);
    const result = await loader('https://blog.example/ap/articles/1');

    expect(result.document).toMatchObject({ type: 'Article' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://blog.example/ap/articles/1',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('keeps private CNAME targets and direct IP failures blocked', async () => {
    const cnamePrimary = vi.fn(async () => {
      throw new UrlError('Invalid or private address: private-host.example.net');
    });
    const privateDnsFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.searchParams.get('type') === 'A') {
        return dnsResponse([{ type: 1, data: '127.0.0.1' }]);
      }
      return dnsResponse([]);
    });
    await expect(withCloudflareCnameFallback(
      cnamePrimary,
      privateDnsFetcher,
    )('https://private.example/object')).rejects.toThrow('127.0.0.1');

    const directIpError = new UrlError('Invalid or private address: 127.0.0.1');
    const directPrimary = vi.fn(async () => { throw directIpError; });
    const unusedFetcher = vi.fn();
    await expect(withCloudflareCnameFallback(
      directPrimary,
      unusedFetcher,
    )('https://127.0.0.1/object')).rejects.toBe(directIpError);
    expect(unusedFetcher).not.toHaveBeenCalled();
  });
});
