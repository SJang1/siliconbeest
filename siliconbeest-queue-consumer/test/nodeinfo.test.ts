import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupRemoteSoftware } from '../src/utils/nodeinfo';

const PUBLIC_HOST = '93.184.216.34';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const USER_AGENT = 'SiliconBeest/Test';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupRemoteSoftware', () => {
  it('returns software metadata from a public NodeInfo endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${PUBLIC_ORIGIN}/.well-known/nodeinfo`) {
        return jsonResponse({
          links: [{
            rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
            href: `${PUBLIC_ORIGIN}/nodeinfo/2.1`,
          }],
        });
      }
      if (url === `${PUBLIC_ORIGIN}/nodeinfo/2.1`) {
        return jsonResponse({ software: { name: 'mastodon', version: '4.4.0' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupRemoteSoftware(PUBLIC_HOST, USER_AGENT)).resolves.toEqual({
      softwareName: 'mastodon',
      softwareVersion: '4.4.0',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['loopback URL', 'http://127.0.0.1:8080/internal'],
    ['data URL', 'data:application/json,{"software":{"name":"secret"}}'],
  ])('does not fetch an advertised %s', async (_label, advertisedUrl) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url !== `${PUBLIC_ORIGIN}/.well-known/nodeinfo`) {
        throw new Error(`SSRF target was fetched: ${url}`);
      }
      return jsonResponse({
        links: [{
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: advertisedUrl,
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupRemoteSoftware(PUBLIC_HOST, USER_AGENT)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not follow a public endpoint redirect to a link-local address', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${PUBLIC_ORIGIN}/.well-known/nodeinfo`) {
        return jsonResponse({
          links: [{
            rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
            href: `${PUBLIC_ORIGIN}/nodeinfo/2.1`,
          }],
        });
      }
      if (url === `${PUBLIC_ORIGIN}/nodeinfo/2.1`) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data' },
        });
      }
      throw new Error(`SSRF redirect target was fetched: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupRemoteSoftware(PUBLIC_HOST, USER_AGENT)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not follow a discovery redirect to a private address', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `${PUBLIC_ORIGIN}/.well-known/nodeinfo`) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://10.0.0.1/nodeinfo/2.1' },
        });
      }
      throw new Error(`SSRF discovery redirect target was fetched: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupRemoteSoftware(PUBLIC_HOST, USER_AGENT)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a private discovery host before fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Private discovery host was fetched: ${requestUrl(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupRemoteSoftware('127.0.0.1', USER_AGENT)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
