/**
 * PLON BIT — Cloudflare Worker Proxy
 * ─────────────────────────────────────────────────────────
 * HOW TO DEPLOY (free, 2 minutes):
 *
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 *  2. Click "Create Worker"
 *  3. Delete the default code and paste ALL of this file
 *  4. Click "Deploy"
 *  5. Copy your worker URL (e.g. https://plonbit-proxy.YOUR-NAME.workers.dev)
 *  6. Paste it into plonbit.html where it says: WORKER_URL = "YOUR_WORKER_URL_HERE"
 *
 * That's it. Free tier = 100,000 requests/day.
 * Works on GitHub Pages, Cloudflare Pages, any tunnel, any domain.
 * ─────────────────────────────────────────────────────────
 */

export default {
  async fetch(request) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const url    = new URL(request.url);
    const target = url.searchParams.get('url');

    // Must have a ?url= param
    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Security: only allow Google Trends RSS
    if (!target.startsWith('https://trends.google.com/trends/trendingsearches/')) {
      return new Response(JSON.stringify({ error: 'Only Google Trends RSS URLs are allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          // Mimic a real browser so Google doesn't block us
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        cf: {
          // Cloudflare edge cache for 3 minutes — reduces upstream calls
          cacheTtl: 180,
          cacheEverything: true,
        }
      });

      const text = await upstream.text();

      return new Response(text, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=180',
          'X-Proxy': 'plonbit-worker',
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
