/**
 * PLON BIT — Cloudflare Worker v4
 * ─────────────────────────────────────────────────────────
 * Source priority:
 *   1. Google Trends RSS  (new 2024+ URL)
 *   2. Google Trends RSS  (legacy URL)
 *   3. Reddit r/all       (always works — no auth needed)
 *   4. HackerNews Top     (always works — no auth needed)
 *
 * All sources return the same normalized JSON shape so the
 * frontend never needs to know which source was used.
 * ─────────────────────────────────────────────────────────
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const BROWSER = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const geo = (url.searchParams.get('geo') || 'US').toUpperCase().slice(0, 2);

    const debug = [];

    // ── 1. Google Trends RSS (new path, 2024+) ─────────────
    const googleResult = await tryGoogleRSS(geo, debug);
    if (googleResult) return jsonResponse(googleResult);

    // ── 2. Reddit r/all (country-agnostic, always available) 
    const redditResult = await tryReddit(geo, debug);
    if (redditResult) return jsonResponse(redditResult);

    // ── 3. HackerNews top stories ─────────────────────────
    const hnResult = await tryHackerNews(debug);
    if (hnResult) return jsonResponse(hnResult);

    // ── All failed ────────────────────────────────────────
    return new Response(JSON.stringify({ error: 'All sources failed', debug, geo }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
};

// ══════════════════════════════════════════════════════════
//  SOURCE 1 — Google Trends RSS
// ══════════════════════════════════════════════════════════
async function tryGoogleRSS(geo, debug) {
  const urls = [
    // New 2024+ endpoint
    `https://trends.google.com/trending/rss?geo=${geo}`,
    // Legacy endpoint
    `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`,
  ];

  for (const rssUrl of urls) {
    const label = rssUrl.includes('/trending/rss') ? 'Google RSS (new)' : 'Google RSS (legacy)';
    try {
      const res = await fetch(rssUrl, {
        headers: BROWSER,
        cf: { cacheTtl: 180, cacheEverything: true },
      });
      debug.push(`${label} → HTTP ${res.status}`);
      if (!res.ok) continue;

      const xml = await res.text();
      if (!xml.includes('<item')) { debug.push(`  ${label}: no <item> tags`); continue; }

      const trends = parseGoogleRSS(xml, geo);
      if (!trends.length) { debug.push(`  ${label}: parsed 0 items`); continue; }

      debug.push(`  ${label}: ✓ ${trends.length} trends`);
      return { source: 'Google Trends', geo, trends, total: trends.length, debug };

    } catch (e) {
      debug.push(`${label}: error — ${e.message}`);
    }
  }
  return null;
}

function parseGoogleRSS(xml, geo) {
  // Use regex since we don't have a DOM parser in Workers
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m, i) => {
    const raw   = m[1];
    const title = stripCDATA(tag(raw, 'title'));
    const link  = stripCDATA(tag(raw, 'link') || tag(raw, 'ht:news_item_url')) ||
                  `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=${geo}`;
    const traffic = stripCDATA(tag(raw, 'ht:approx_traffic'));
    const pic     = stripCDATA(tag(raw, 'ht:picture'));
    const desc    = stripCDATA(tag(raw, 'description')).replace(/<[^>]*>/g, '').trim();
    const pubDate = tag(raw, 'pubDate');

    // Related queries inside <ht:news_item>
    const related = [...raw.matchAll(/<ht:query>([\s\S]*?)<\/ht:query>/g)]
      .map(r => stripCDATA(r[1])).filter(Boolean).slice(0, 3);

    return {
      rank: i + 1, title, traffic, link, pubDate,
      articles: desc ? [{ title, snippet: desc, url: link, source: '', img: pic }] : [],
      relatedQueries: related,
    };
  }).filter(t => t.title);
}

// ══════════════════════════════════════════════════════════
//  SOURCE 2 — Reddit r/all (no API key, no CORS block)
// ══════════════════════════════════════════════════════════
async function tryReddit(geo, debug) {
  // Use country-specific subreddits when possible
  const subMap = { GB:'unitedkingdom', CA:'canada', AU:'australia', IN:'india', DE:'de', FR:'france', BR:'brasil' };
  const sub  = subMap[geo] || 'all';
  const url  = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlonBit/1.0 (trending dashboard)', 'Accept': 'application/json' },
      cf: { cacheTtl: 180 },
    });
    debug.push(`Reddit r/${sub} → HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const posts = (data?.data?.children || [])
      .filter(p => !p.data.stickied && p.data.title)
      .slice(0, 20);

    if (!posts.length) { debug.push('  Reddit: 0 posts'); return null; }

    const trends = posts.map((p, i) => {
      const d = p.data;
      const score = d.score >= 1000 ? `${Math.round(d.score/1000)}K upvotes` : `${d.score} upvotes`;
      const thumb = (d.thumbnail && d.thumbnail.startsWith('http')) ? d.thumbnail : '';
      return {
        rank:           i + 1,
        title:          d.title,
        traffic:        score,
        link:           `https://reddit.com${d.permalink}`,
        pubDate:        '',
        articles:       d.selftext ? [{ title: d.title, snippet: d.selftext.slice(0, 200), url: `https://reddit.com${d.permalink}`, source: `r/${d.subreddit}`, img: thumb }] : [{ title: d.title, snippet: '', url: `https://reddit.com${d.permalink}`, source: `r/${d.subreddit}`, img: thumb }],
        relatedQueries: [`r/${d.subreddit}`],
      };
    });

    debug.push(`  Reddit: ✓ ${trends.length} posts`);
    return { source: `Reddit r/${sub}`, geo, trends, total: trends.length, debug };

  } catch (e) {
    debug.push(`Reddit: error — ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  SOURCE 3 — HackerNews
// ══════════════════════════════════════════════════════════
async function tryHackerNews(debug) {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      cf: { cacheTtl: 180 }
    });
    debug.push(`HackerNews → HTTP ${idsRes.status}`);
    if (!idsRes.ok) throw new Error(`HTTP ${idsRes.status}`);

    const ids = (await idsRes.json()).slice(0, 20);

    const stories = await Promise.all(ids.map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        .then(r => r.json())
        .catch(() => null)
    ));

    const trends = stories
      .filter(s => s && s.title && s.type === 'story')
      .map((s, i) => ({
        rank:           i + 1,
        title:          s.title,
        traffic:        `${s.score || 0} points`,
        link:           s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        pubDate:        '',
        articles:       [{ title: s.title, snippet: '', url: s.url || `https://news.ycombinator.com/item?id=${s.id}`, source: 'Hacker News', img: '' }],
        relatedQueries: [],
      }));

    if (!trends.length) { debug.push('  HN: 0 stories'); return null; }
    debug.push(`  HN: ✓ ${trends.length} stories`);
    return { source: 'Hacker News', geo: 'GLOBAL', trends, total: trends.length, debug };

  } catch (e) {
    debug.push(`HackerNews: error — ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1].trim() : '';
}
function stripCDATA(s) {
  return (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
}
function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=180', ...CORS }
  });
}
