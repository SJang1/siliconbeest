/**
 * OpenGraph Metadata Fetcher
 *
 * Fetches and parses OpenGraph tags from a URL.
 * Designed to work in Cloudflare Workers (no DOM parser).
 */

export interface OgData {
  url: string;
  title: string;
  description: string;
  image: string | null;
  type: string;
  provider_name: string;
  provider_url: string;
}

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

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return null;
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

/** Extract the domain from a URL for provider_name. */
function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Fetch OpenGraph metadata from a URL.
 *
 * - 5 second timeout
 * - Reads only the first 50KB of HTML
 * - Returns null on any failure
 */
export async function fetchOgMetadata(url: string): Promise<OgData | null> {
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

    let html = '';
    const decoder = new TextDecoder();
    const MAX_BYTES = 50 * 1024;
    let totalBytes = 0;

    while (totalBytes < MAX_BYTES) {
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
    const domain = extractDomain(finalUrl);

    return {
      url: finalUrl,
      title,
      description,
      image: ogImage || null,
      type: ogType || 'link',
      provider_name: ogSiteName || domain,
      provider_url: `https://${domain}`,
    };
  } catch {
    return null;
  }
}
