/**
 * Queue handler: fetch_preview_card
 *
 * Fetches OpenGraph metadata for a URL and stores it as a preview card
 * linked to the originating status.
 */

import type { Env } from '../env';
import type { FetchPreviewCardMessage } from '../shared/types/queue';

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

function extractMeta(html: string, property: string): string | null {
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

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

interface OgData {
  url: string;
  title: string;
  description: string;
  image: string | null;
  type: string;
  provider_name: string;
  provider_url: string;
}

async function fetchOgMetadata(url: string): Promise<OgData | null> {
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

    const ogTitle = extractMeta(html, 'og:title');
    const ogDescription = extractMeta(html, 'og:description');
    const ogImage = extractMeta(html, 'og:image');
    const ogType = extractMeta(html, 'og:type');
    const ogSiteName = extractMeta(html, 'og:site_name');
    const ogUrl = extractMeta(html, 'og:url');

    const title = ogTitle || extractTitle(html) || '';
    const description = ogDescription || extractMeta(html, 'description') || '';

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

function generateId(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

export async function handleFetchPreviewCard(
  msg: FetchPreviewCardMessage,
  env: Env,
): Promise<void> {
  const { statusId, url } = msg;

  // Check KV cache first
  const cacheKey = `og:${url}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    // Card already fetched; just link it to the status
    const existingCard = await env.DB.prepare(
      'SELECT id FROM preview_cards WHERE url = ?1',
    ).bind(url).first();
    if (existingCard) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO status_preview_cards (status_id, preview_card_id) VALUES (?1, ?2)',
      ).bind(statusId, existingCard.id as string).run();
    }
    return;
  }

  // Check if preview_card already exists in DB
  const existingCard = await env.DB.prepare(
    'SELECT id FROM preview_cards WHERE url = ?1',
  ).bind(url).first();

  if (existingCard) {
    // Link existing card to this status
    await env.DB.prepare(
      'INSERT OR IGNORE INTO status_preview_cards (status_id, preview_card_id) VALUES (?1, ?2)',
    ).bind(statusId, existingCard.id as string).run();
    // Cache the URL
    await env.CACHE.put(cacheKey, '1', { expirationTtl: 86400 });
    return;
  }

  // Fetch OG metadata
  const og = await fetchOgMetadata(url);
  if (!og) {
    // Cache the failure to avoid repeated fetches
    await env.CACHE.put(cacheKey, '0', { expirationTtl: 3600 });
    return;
  }

  const cardId = generateId();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO preview_cards (id, url, title, description, type, provider_name, provider_url, image_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(
      cardId,
      og.url,
      og.title,
      og.description,
      og.type === 'video' ? 'video' : og.type === 'photo' ? 'photo' : 'link',
      og.provider_name,
      og.provider_url,
      og.image,
      now,
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO status_preview_cards (status_id, preview_card_id) VALUES (?1, ?2)',
    ).bind(statusId, cardId),
  ]);

  // Cache the URL with 24h TTL
  await env.CACHE.put(cacheKey, '1', { expirationTtl: 86400 });
}
