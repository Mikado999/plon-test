/**
 * PLON BIT — Cloudflare Worker v5
 * ─────────────────────────────────────────────────────────
 * Source priority:
 *   1. Google Trends RSS  (new 2024+ URL)
 *   2. Google Trends RSS  (legacy URL)
 *   3. Reddit r/all       (country-aware, always works)
 *   4. YouTube            (most popular videos, public RSS)
 *   5. HackerNews Top     (always works)
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

    const url    = new URL(request.url);
    const geo    = (url.searchParams.get('geo') || 'US').toUpperCase().slice(0, 2);
    const source = url.searchParams.get('source') || 'auto'; // allow forcing a source
    const debug  = [];

    // Force a specific source if requested
    if (source === 'reddit') {
      const r = await tryReddit(geo, debug);
      if (r) return ok(r);
    }
    if (source === 'youtube') {
      const r = await tryYouTube(geo, debug);
      if (r) return ok(r);
    }
    if (source === 'hackernews') {
      const r = await tryHackerNews(debug);
      if (r) return ok(r);
    }

    // Auto: try all in priority order
    const result =
      await tryGoogleRSS(geo, debug)  ||
      await tryReddit(geo, debug)     ||
      await tryYouTube(geo, debug)    ||
      await tryHackerNews(debug);

    if (result) return ok(result);

    return new Response(
      JSON.stringify({ error: 'All sources failed', debug, geo }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }
};

function ok(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=180', ...CORS }
  });
}

// ══════════════════════════════════════════════════════════
//  1 — Google Trends RSS
// ══════════════════════════════════════════════════════════
async function tryGoogleRSS(geo, debug) {
  const candidates = [
    { label: 'Google RSS (new)',    url: `https://trends.google.com/trending/rss?geo=${geo}` },
    { label: 'Google RSS (legacy)', url: `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}` },
  ];
  for (const { label, url } of candidates) {
    try {
      const res = await fetch(url, { headers: BROWSER, cf: { cacheTtl: 180, cacheEverything: true } });
      debug.push(`${label} → HTTP ${res.status}`);
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('<item')) { debug.push(`  ${label}: no <item> tags`); continue; }
      const trends = parseGoogleRSS(xml, geo);
      if (!trends.length) { debug.push(`  ${label}: 0 items parsed`); continue; }
      debug.push(`  ${label}: ✓ ${trends.length} trends`);
      return { source: 'Google Trends', sourceType: 'google', geo, trends, total: trends.length, debug };
    } catch (e) { debug.push(`${label}: error — ${e.message}`); }
  }
  return null;
}

function parseGoogleRSS(xml, geo) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m, i) => {
    const raw     = m[1];
    const title   = stripCDATA(tag(raw, 'title'));
    const link    = stripCDATA(tag(raw, 'link') || tag(raw, 'ht:news_item_url')) ||
                    `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=${geo}`;
    const traffic = stripCDATA(tag(raw, 'ht:approx_traffic'));
    const pic     = stripCDATA(tag(raw, 'ht:picture'));
    const desc    = stripCDATA(tag(raw, 'description')).replace(/<[^>]*>/g, '').trim();
    const pubDate = tag(raw, 'pubDate');
    const related = [...raw.matchAll(/<ht:query>([\s\S]*?)<\/ht:query>/g)]
      .map(r => stripCDATA(r[1])).filter(Boolean).slice(0, 4);
    return {
      rank: i + 1, title, traffic, link, pubDate,
      articles: [{ title, snippet: desc, url: link, source: 'Google Trends', img: pic }],
      relatedQueries: related,
    };
  }).filter(t => t.title);
}

// ══════════════════════════════════════════════════════════
//  2 — Reddit
// ══════════════════════════════════════════════════════════
async function tryReddit(geo, debug) {
  const subMap = { GB:'unitedkingdom', CA:'canada', AU:'australia', IN:'india', DE:'de', FR:'france', BR:'brasil' };
  const sub    = subMap[geo] || 'all';
  const url    = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlonBit/1.0', 'Accept': 'application/json' },
      cf: { cacheTtl: 180 },
    });
    debug.push(`Reddit r/${sub} → HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const posts = (data?.data?.children || []).filter(p => !p.data.stickied && p.data.title).slice(0, 20);
    if (!posts.length) { debug.push('  Reddit: 0 posts'); return null; }
    const trends = posts.map((p, i) => {
      const d     = p.data;
      const score = d.score >= 1000 ? `${Math.round(d.score/1000)}K upvotes` : `${d.score} upvotes`;
      const thumb = d.thumbnail?.startsWith('http') ? d.thumbnail : '';
      const img   = d.preview?.images?.[0]?.source?.url?.replace(/&amp;/g,'&') || thumb;
      return {
        rank: i+1, title: d.title, traffic: score,
        link: `https://reddit.com${d.permalink}`, pubDate: '',
        articles: [{ title: d.title, snippet: d.selftext?.slice(0,200)||'', url:`https://reddit.com${d.permalink}`, source:`r/${d.subreddit}`, img }],
        relatedQueries: [`r/${d.subreddit}`],
        score: d.score, numComments: d.num_comments,
      };
    });
    debug.push(`  Reddit: ✓ ${trends.length} posts`);
    return { source:`Reddit r/${sub}`, sourceType:'reddit', geo, trends, total:trends.length, debug };
  } catch (e) { debug.push(`Reddit: error — ${e.message}`); return null; }
}

// ══════════════════════════════════════════════════════════
//  3 — YouTube Most Popular (public Atom RSS, no API key)
// ══════════════════════════════════════════════════════════
async function tryYouTube(geo, debug) {
  // YouTube's public most-popular feed doesn't support all country codes, fall back to global
  const regionMap = { US:'US', GB:'GB', CA:'CA', AU:'AU', IN:'IN', DE:'DE', FR:'FR', BR:'BR' };
  const region    = regionMap[geo] || 'US';
  const url       = `https://www.youtube.com/feeds/videos.xml?chart=mostpopular&regionCode=${region}&hl=en`;
  try {
    const res = await fetch(url, { headers: BROWSER, cf: { cacheTtl: 180, cacheEverything: true } });
    debug.push(`YouTube RSS (${region}) → HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml    = await res.text();
    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    if (!videos.length) { debug.push('  YouTube: no entries'); return null; }

    const trends = videos.slice(0, 20).map((m, i) => {
      const raw     = m[1];
      const title   = stripCDATA(tag(raw, 'title'));
      const videoId = stripCDATA(tag(raw, 'yt:videoId'));
      const link    = videoId ? `https://youtube.com/watch?v=${videoId}` : '';
      const author  = stripCDATA(tag(raw, 'name'));
      // media:group contains thumbnail and description
      const mediaGrp= raw.match(/<media:group>([\s\S]*?)<\/media:group>/)?.[1] || '';
      const thumb   = mediaGrp.match(/url="([^"]+)"/)?.[1] || '';
      const desc    = stripCDATA(mediaGrp.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]||'').slice(0,200);
      const views   = stripCDATA(tag(raw,'media:statistics')).match(/views="(\d+)"/)?.[1];
      const traffic = views ? `${formatNum(parseInt(views))} views` : 'Trending';
      return {
        rank: i+1, title, traffic, link, pubDate:'',
        articles: [{ title, snippet: desc, url: link, source: author || 'YouTube', img: thumb }],
        relatedQueries: [],
      };
    }).filter(t => t.title && t.link);

    if (!trends.length) { debug.push('  YouTube: 0 valid entries'); return null; }
    debug.push(`  YouTube: ✓ ${trends.length} videos`);
    return { source:'YouTube Trending', sourceType:'youtube', geo, trends, total:trends.length, debug };
  } catch (e) { debug.push(`YouTube: error — ${e.message}`); return null; }
}

// ══════════════════════════════════════════════════════════
//  4 — HackerNews
// ══════════════════════════════════════════════════════════
async function tryHackerNews(debug) {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { cf:{ cacheTtl:180 } });
    debug.push(`HackerNews → HTTP ${idsRes.status}`);
    if (!idsRes.ok) throw new Error(`HTTP ${idsRes.status}`);
    const ids    = (await idsRes.json()).slice(0, 20);
    const stories = await Promise.all(ids.map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r=>r.json()).catch(()=>null)
    ));
    const trends = stories.filter(s=>s&&s.title&&s.type==='story').map((s,i)=>({
      rank: i+1, title: s.title,
      traffic: `${s.score||0} points`,
      link: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
      pubDate: '',
      articles: [{ title:s.title, snippet:'', url:s.url||`https://news.ycombinator.com/item?id=${s.id}`, source:'Hacker News', img:'' }],
      relatedQueries: [],
    }));
    if (!trends.length) { debug.push('  HN: 0 stories'); return null; }
    debug.push(`  HN: ✓ ${trends.length} stories`);
    return { source:'Hacker News', sourceType:'hackernews', geo:'GLOBAL', trends, total:trends.length, debug };
  } catch (e) { debug.push(`HackerNews: error — ${e.message}`); return null; }
}

// ══════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1].trim() : '';
}
function stripCDATA(s) {
  return (s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
}
function formatNum(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return Math.round(n/1e3)+'K';
  return String(n);
}
