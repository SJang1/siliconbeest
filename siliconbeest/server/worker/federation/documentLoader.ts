import {
  FetchError,
  type DocumentLoader,
  type DocumentLoaderOptions,
  type RemoteDocument,
  UrlError,
  getRemoteDocument,
  isValidPublicIPv4Address,
  isValidPublicIPv6Address,
} from '@fedify/vocab-runtime';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface DnsAnswer {
  type: number;
  data: string;
}

interface DnsJsonResponse {
  Status?: number;
  Answer?: DnsAnswer[];
}

const DNS_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const MAX_DNS_DEPTH = 8;
const MAX_DNS_ANSWERS = 64;
const MAX_REDIRECTIONS = 10;

function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

function validateIpAddress(address: string, family: 4 | 6): void {
  const valid = family === 4
    ? isValidPublicIPv4Address(address)
    : isValidPublicIPv6Address(address);
  if (!valid) throw new UrlError(`Invalid or private address: ${address}`);
}

async function queryDns(
  hostname: string,
  type: 'A' | 'AAAA',
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<DnsAnswer[]> {
  const url = new URL(DNS_ENDPOINT);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', type);
  const response = await fetcher(url, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual',
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    throw new FetchError(url, 'DNS-over-HTTPS must not redirect', response);
  }
  if (!response.ok) {
    throw new FetchError(url, `DNS-over-HTTPS returned HTTP ${response.status}`, response);
  }
  const body = await response.json<DnsJsonResponse>();
  if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];
  if (body.Answer.length > MAX_DNS_ANSWERS) {
    throw new UrlError(`Too many DNS answers for ${hostname}`);
  }
  return body.Answer.filter(
    (answer): answer is DnsAnswer =>
      !!answer
      && typeof answer.type === 'number'
      && typeof answer.data === 'string',
  );
}

async function validatePublicHostname(
  rawHostname: string,
  fetcher: Fetcher,
  signal: AbortSignal | undefined,
  visited: Set<string>,
  depth = 0,
): Promise<void> {
  const hostname = normalizeDnsName(rawHostname.replace(/^\[|\]$/g, ''));
  if (!hostname || hostname === 'localhost') {
    throw new UrlError(`Invalid or private address: ${hostname || rawHostname}`);
  }
  if (isValidPublicIPv4Address(hostname)) return;
  if (isValidPublicIPv6Address(hostname)) return;
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    throw new UrlError(`Invalid or private address: ${hostname}`);
  }
  if (depth >= MAX_DNS_DEPTH || visited.has(hostname)) {
    throw new UrlError(`Invalid DNS alias chain: ${hostname}`);
  }
  visited.add(hostname);

  const answers = (await Promise.all([
    queryDns(hostname, 'A', fetcher, signal),
    queryDns(hostname, 'AAAA', fetcher, signal),
  ])).flat();
  let foundPublicAddress = false;
  const aliases = new Set<string>();
  for (const answer of answers) {
    if (answer.type === 1) {
      validateIpAddress(answer.data, 4);
      foundPublicAddress = true;
    } else if (answer.type === 28) {
      validateIpAddress(answer.data, 6);
      foundPublicAddress = true;
    } else if (answer.type === 5) {
      aliases.add(normalizeDnsName(answer.data));
    }
  }
  for (const alias of aliases) {
    await validatePublicHostname(alias, fetcher, signal, visited, depth + 1);
    foundPublicAddress = true;
  }
  if (!foundPublicAddress) {
    throw new UrlError(`No public address found for ${hostname}`);
  }
}

async function validatePublicUrlWithDnsOverHttps(
  value: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
  ) {
    throw new UrlError(`Unsupported URL: ${value}`);
  }
  await validatePublicHostname(url.hostname, fetcher, signal, new Set());
}

function isCloudflareCnameFalsePositive(error: unknown): boolean {
  if (!(error instanceof UrlError)) return false;
  const match = /^Invalid or private address: ([^\s]+)$/.exec(error.message);
  if (!match) return false;
  const address = normalizeDnsName(match[1]);
  return address.includes(':') === false
    && /^[a-z0-9.-]+$/i.test(address)
    && /[a-z]/i.test(address);
}

function createSafeFallbackLoader(fetcher: Fetcher): DocumentLoader {
  const load = async (
    value: string,
    options?: DocumentLoaderOptions,
    redirected = 0,
    visited: Set<string> = new Set(),
  ): Promise<RemoteDocument> => {
    options?.signal?.throwIfAborted();
    const currentUrl = new URL(value).href;
    if (visited.has(currentUrl)) {
      throw new FetchError(currentUrl, `Redirect loop detected: ${currentUrl}`);
    }
    if (redirected > MAX_REDIRECTIONS) {
      throw new FetchError(currentUrl, `Too many redirections (${redirected})`);
    }
    visited.add(currentUrl);
    await validatePublicUrlWithDnsOverHttps(currentUrl, fetcher, options?.signal);

    const response = await fetcher(currentUrl, {
      headers: {
        Accept: 'application/activity+json, application/ld+json',
        'User-Agent': 'SiliconBeest/1.0',
      },
      redirect: 'manual',
      signal: options?.signal,
    });
    if (
      response.status >= 300
      && response.status < 400
      && response.headers.has('Location')
    ) {
      const nextUrl = new URL(response.headers.get('Location')!, currentUrl).href;
      return load(nextUrl, options, redirected + 1, visited);
    }
    return getRemoteDocument(
      currentUrl,
      response,
      (nextUrl, nextOptions) => load(nextUrl, nextOptions, redirected + 1, visited),
    );
  };
  return load;
}

/**
 * Work around node:dns returning a CNAME hostname as LookupAddress.address in
 * Cloudflare Workers. Fedify correctly rejects that non-IP value, so retry
 * only that false-positive case with explicit DoH validation on every fetch.
 */
export function withCloudflareCnameFallback(
  primary: DocumentLoader,
  fetcher: Fetcher = fetch,
): DocumentLoader {
  const fallback = createSafeFallbackLoader(fetcher);
  return async (url, options) => {
    try {
      return await primary(url, options);
    } catch (error) {
      if (!isCloudflareCnameFalsePositive(error)) throw error;
      return fallback(url, options);
    }
  };
}
