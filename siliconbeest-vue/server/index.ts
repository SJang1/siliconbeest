// SPA server handler with OG meta tag support for crawlers.
// Static assets and SPA fallback are handled by Cloudflare Workers Assets
// (configured via "not_found_handling": "single-page-application" in wrangler.jsonc).
//
// For crawler/bot requests (Googlebot, Twitterbot, Discordbot, etc.), we intercept
// the request, fetch data from the API, and return minimal HTML with proper OG meta
// tags so link previews work correctly on social platforms.
//
// For normal users, we return nothing so the assets handler serves the SPA.

import { isCrawler, handleOgRequest } from './og-handler';

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get('User-Agent');

    // Only intercept HTML page requests from crawlers (not assets like .js, .css, etc.)
    if (isCrawler(ua)) {
      const url = new URL(request.url);
      const path = url.pathname;

      // Skip static asset requests — let the assets handler serve them
      if (
        path.startsWith('/assets/') ||
        path.startsWith('/favicon') ||
        path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|avif|map|json)$/)
      ) {
        return new Response(null, { status: 404 });
      }

      const ogResponse = await handleOgRequest(url, env.API_WORKER);
      if (ogResponse) return ogResponse;
    }

    // Let Cloudflare Workers Assets handle everything for normal users.
    // The "not_found_handling: single-page-application" setting
    // will serve index.html for any path that doesn't match a static file.
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
