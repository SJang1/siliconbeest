// OG (Open Graph) meta tag handler for crawler/bot requests
// When a crawler visits a page URL, this returns minimal HTML with proper OG meta tags
// instead of the full SPA, so link previews work on Twitter, Discord, Slack, Mastodon, etc.

import app from './worker/index';

// User-Agent patterns for crawlers/bots that need OG tags
const CRAWLER_UA =
  /bot|crawler|spider|curl|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|Telegram|embedly|Mastodon|Misskey|Pleroma|Akkoma|http\.rb|Phanpy|Elk|Ivory|Ice\sCubes/i;

export function isCrawler(userAgent: string | null): boolean {
  return userAgent ? CRAWLER_UA.test(userAgent) : false;
}

// ---------------------------------------------------------------------------
// URL pattern matching
// ---------------------------------------------------------------------------

interface PageMatch {
  type: 'status' | 'profile' | 'about' | 'generic';
  params: Record<string, string>;
}

export function parsePageType(pathname: string): PageMatch {
  // /@username/statusId  (statusId is alphanumeric / numeric)
  const statusMatch = pathname.match(/^\/@([^/]+)\/([A-Za-z0-9]+)$/);
  if (statusMatch?.[1] && statusMatch[2]) {
    return { type: 'status', params: { acct: statusMatch[1], statusId: statusMatch[2] } };
  }

  // /%40username/statusId  (percent-encoded @)
  const statusMatchEncoded = pathname.match(/^\/%40([^/]+)\/([A-Za-z0-9]+)$/);
  if (statusMatchEncoded?.[1] && statusMatchEncoded[2]) {
    return { type: 'status', params: { acct: statusMatchEncoded[1], statusId: statusMatchEncoded[2] } };
  }

  // /@username (profile)
  const profileMatch = pathname.match(/^\/@([^/]+)$/);
  if (profileMatch?.[1]) {
    return { type: 'profile', params: { acct: profileMatch[1] } };
  }

  // /%40username (profile, percent-encoded)
  const profileMatchEncoded = pathname.match(/^\/%40([^/]+)$/);
  if (profileMatchEncoded?.[1]) {
    return { type: 'profile', params: { acct: profileMatchEncoded[1] } };
  }

  // /about or /about/more
  if (pathname === '/about' || pathname === '/about/more') {
    return { type: 'about', params: {} };
  }

  // everything else (home, explore, search, etc.)
  return { type: 'generic', params: {} };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 1) + '\u2026';
}

interface OgOptions {
  title: string;
  description: string;
  url: string;
  image?: string;
  type?: string; // 'website' | 'article' | 'profile'
  siteName: string;
  locale?: string;
  author?: string;
}

export function generateOgHtml(opts: OgOptions): string {
  const {
    title,
    description,
    url,
    image,
    type = 'website',
    siteName,
    locale,
  } = opts;

  const titleEsc = escapeAttr(title);
  const descEsc = escapeAttr(truncate(description, 300));

  return `<!DOCTYPE html>
<html lang="${locale || 'en'}">
<head>
  <meta charset="utf-8" />
  <title>${titleEsc}</title>
  <meta name="description" content="${descEsc}" />
  <meta property="og:title" content="${titleEsc}" />
  <meta property="og:description" content="${descEsc}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:type" content="${type}" />
  <meta property="og:site_name" content="${escapeAttr(siteName)}" />
  ${image ? `<meta property="og:image" content="${escapeAttr(image)}" />` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${titleEsc}" />
  <meta name="twitter:description" content="${descEsc}" />
  ${image ? `<meta name="twitter:image" content="${escapeAttr(image)}" />` : ''}
  <link rel="icon" href="/favicon.ico" />
  <link rel="canonical" href="${escapeAttr(url)}" />
</head>
<body>
  <p>${descEsc}</p>
  <p><a href="${escapeAttr(url)}">View on ${escapeAttr(siteName)}</a></p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function fetchApi(domain: string, path: string): Promise<any> {
  try {
    const res = await app.request(path, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`[og] Fetch error for ${path}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler — returns Response for crawlers, or null to fall through to SPA
// ---------------------------------------------------------------------------

export async function handleOgRequest(url: URL): Promise<Response | null> {
  const domain = url.hostname;
  const page = parsePageType(url.pathname);

  // Fetch instance info (used by all page types as fallback and for siteName)
  const instanceData = await fetchApi(domain, '/api/v2/instance');
  const siteName: string = instanceData?.title || 'SiliconBeest';
  const siteDescription: string =
    stripHtml(instanceData?.description || instanceData?.short_description || '') ||
    'A Mastodon-compatible social network';
  const siteThumbnail: string | undefined = instanceData?.thumbnail?.url;

  if (page.type === 'status') {
    const statusData = await fetchApi(domain, `/api/v1/statuses/${page.params.statusId}`);
    if (statusData) {
      // Don't expose private/direct status content in OG tags
      const vis = statusData.visibility;
      if (vis === 'private' || vis === 'direct') {
        return new Response(
          generateOgHtml({
            title: siteName,
            description: `This post is not publicly available.`,
            url: url.toString(),
            type: 'article',
            siteName,
          }),
          { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } },
        );
      }

      const account = statusData.account;
      const displayName = account?.display_name || account?.username || 'Unknown';
      const acct = account?.acct || '';
      const contentText = stripHtml(statusData.content || '');
      const image: string | undefined =
        statusData.media_attachments?.[0]?.preview_url ||
        statusData.media_attachments?.[0]?.url;

      return new Response(
        generateOgHtml({
          title: `${displayName} (@${acct})`,
          description: contentText || `Post by @${acct}`,
          url: url.toString(),
          image,
          type: 'article',
          siteName,
          author: `@${acct}`,
        }),
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } },
      );
    }
    // Status not found — fall through to generic
  }

  if (page.type === 'profile') {
    const acct = page.params.acct;
    const accountData = await fetchApi(domain, `/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
    if (accountData) {
      const displayName = accountData.display_name || accountData.username || acct;
      const bio = stripHtml(accountData.note || '');
      const avatar: string | undefined = accountData.avatar;

      return new Response(
        generateOgHtml({
          title: `${displayName} (@${accountData.acct || acct})`,
          description: bio || `Profile of @${accountData.acct || acct} on ${siteName}`,
          url: url.toString(),
          image: avatar,
          type: 'profile',
          siteName,
        }),
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } },
      );
    }
  }

  if (page.type === 'about') {
    return new Response(
      generateOgHtml({
        title: `About | ${siteName}`,
        description: siteDescription,
        url: url.toString(),
        image: siteThumbnail,
        type: 'website',
        siteName,
      }),
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } },
    );
  }

  // Generic / fallback for any other page
  return new Response(
    generateOgHtml({
      title: siteName,
      description: siteDescription,
      url: url.toString(),
      image: siteThumbnail,
      type: 'website',
      siteName,
    }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } },
  );
}
