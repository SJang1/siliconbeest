/**
 * OpenGraph Metadata Fetcher
 *
 * Fetches and parses OpenGraph tags from a URL.
 * Designed to work in Cloudflare Workers (no DOM parser).
 */

import { extractDomain } from '../../../../packages/shared/domain-blocks';

export type OgData = {
  url: string;
  title: string;
  description: string;
  image: string | null;
  type: string;
  provider_name: string;
  provider_url: string;
};

/**
 * Extract content from an OG or meta tag using regex.
 * Handles both property="og:..." and name="..." variants,
 * as well as single and double quotes, and varying attribute order.
 */
function extractMeta(html: string, property: string): string | null {
  // Match <meta property="og:title" content="..."> or <meta content="..." property="og:title">
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i'),
  ];

  const result = patterns
    .map((pattern) => html.match(pattern))
    .find((m) => m?.[1]);
  return result?.[1] ? decodeHtmlEntities(result[1]) : null;
}

/** Extract the <title> tag content as a fallback. */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null;
}

/** Basic HTML entity decoding. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Fetch OpenGraph metadata from a URL.
 *
 * - 5 second timeout
 * - Reads only the first 50KB of HTML
 * - Returns null on any failure
 */
export async function fetchOgMetadata(url: string): Promise<OgData | null> {
  // oxlint-disable-next-line fp/no-try-statements
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SiliconBeest/1.0 (OpenGraph Fetcher)',
        Accept: 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    // Read only the first 50KB
    const reader = response.body?.getReader();
    if (!reader) return null;

    // oxlint-disable-next-line fp/no-let
    let html = '';
    const decoder = new TextDecoder();
    const MAX_BYTES = 50 * 1024;
    // oxlint-disable-next-line fp/no-let
    let totalBytes = 0;

    // oxlint-disable-next-line fp/no-loop-statements
    while (totalBytes < MAX_BYTES) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }

    reader.cancel().catch(() => {});

    // Parse OG tags
    const ogTitle = extractMeta(html, 'og:title');
    const ogDescription = extractMeta(html, 'og:description');
    const ogImage = extractMeta(html, 'og:image');
    const ogType = extractMeta(html, 'og:type');
    const ogSiteName = extractMeta(html, 'og:site_name');
    const ogUrl = extractMeta(html, 'og:url');

    // Fallbacks
    const title = ogTitle || extractTitle(html) || '';
    const description =
      ogDescription || extractMeta(html, 'description') || '';

    // If no meaningful data was found, return null
    if (!title && !description && !ogImage) return null;

    const finalUrl = ogUrl || url;
    const domain = extractDomain(finalUrl) ?? '';

    return {
      url: finalUrl,
      title,
      description,
      image: ogImage || null,
      type: ogType || 'link',
      provider_name: ogSiteName || domain,
      provider_url: `https://${domain}`,
    };
  } catch (e) {
    // Transient errors (network, timeout) → rethrow for queue retry
    if (e instanceof DOMException && e.name === 'AbortError') {
      // oxlint-disable-next-line fp/no-throw-statements, fp/no-promise-reject
      throw new Error(`OG fetch timeout for ${url}`);
    }
    if (e instanceof TypeError) {
      // fetch() network errors are TypeError
      // oxlint-disable-next-line fp/no-throw-statements, fp/no-promise-reject
      throw new Error(`OG fetch network error for ${url}: ${e.message}`);
    }
    // Non-transient (parse errors etc.) → log and give up
    console.error(`OG fetch failed for ${url}:`, e);
    return null;
  }
}
