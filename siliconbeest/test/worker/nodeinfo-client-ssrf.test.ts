import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupRemoteSoftware } from '../../../siliconbeest-queue-consumer/src/utils/nodeinfo';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queue consumer NodeInfo SSRF protection', () => {
  it('rejects a hostname that resolves to loopback in the Workers runtime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === 'https://cloudflare-dns.com/dns-query?name=localtest.me&type=A') {
        return dnsJsonResponse('A', '127.0.0.1');
      }
      if (url === 'https://cloudflare-dns.com/dns-query?name=localtest.me&type=AAAA') {
        return dnsJsonResponse('AAAA', '::1');
      }
      return new Response(null, { status: 502 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      lookupRemoteSoftware('localtest.me', 'SiliconBeest/Test'),
    ).resolves.toBeNull();
    const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(requestedUrls).toContain(
      'https://cloudflare-dns.com/dns-query?name=localtest.me&type=A',
    );
    expect(requestedUrls).toContain(
      'https://cloudflare-dns.com/dns-query?name=localtest.me&type=AAAA',
    );
    expect(requestedUrls).not.toContain('https://localtest.me/.well-known/nodeinfo');
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function dnsJsonResponse(recordType: 'A' | 'AAAA', address: string): Response {
  const type = recordType === 'A' ? 1 : 28;
  return Response.json({
    Status: 0,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name: 'localtest.me.', type }],
    Answer: [{ name: 'localtest.me.', type, TTL: 60, data: address }],
  }, {
    headers: { 'Content-Type': 'application/dns-json' },
  });
}
