// TrollBridge /markets + /search lanes — data layer (the $0 edition).
// /markets: Polymarket's free public gamma API (no key). Odds move fast,
// so the cache is short (15 min) — stale beats hammering rate limits.
// /search: provider chain — Brave Search API when BRAVE_API_KEY is set
// (2,000/mo free tier), otherwise DuckDuckGo HTML parsed server-side.
// v1 ships on the DuckDuckGo fallback with zero signup. 1h cache by query.
// Every function degrades gracefully: stale cache or a clear "unavailable"
// beats a fake number, always.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const POLY_GAMMA = "https://gamma-api.polymarket.com";
const DDG_HTML = "https://html.duckduckgo.com/html/?q=";
const BRAVE_API = "https://api.search.brave.com/res/v1/web/search";

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url, opts = {}) {
  const res = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

// ---- tiny TTL cache ----
function makeCache(ttlMs, max = 500) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) { m.delete(k); return null; }
      return e.v;
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const marketsCache = makeCache(15 * 60 * 1000);
const searchCache = makeCache(60 * 60 * 1000);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function parseOutcomes(market) {
  // Polymarket encodes outcomes/prices as JSON strings: '["Yes","No"]', '["0.65","0.35"]'
  let outcomes = [], prices = [];
  try { outcomes = JSON.parse(market.outcomes || "[]"); } catch { /* keep empty */ }
  try { prices = JSON.parse(market.outcomePrices || "[]"); } catch { /* keep empty */ }
  return outcomes.map((o, i) => ({ outcome: String(o), price: prices[i] != null ? num(prices[i]) : null }));
}

// ---- /markets: prediction-market intel from Polymarket's free API ----
async function searchMarkets(q, limit) {
  const query = String(q || "").trim();
  if (!query) throw badRequest('missing required query param "q" — try GET /markets?q=bitcoin');
  let n = parseInt(limit, 10);
  if (!Number.isFinite(n)) n = 10;
  n = Math.max(1, Math.min(25, n));
  const key = `q:${query.toLowerCase()}:n:${n}`;
  const hit = marketsCache.get(key);
  if (hit) return { ...hit, cached: true };

  const j = await getJSON(`${POLY_GAMMA}/public-search?q=${encodeURIComponent(query)}`);
  const events = ((j && j.events) || []).slice(0, n).map((ev) => ({
    title: ev.title,
    slug: ev.slug,
    url: ev.slug ? `https://polymarket.com/event/${ev.slug}` : null,
    liquidity_usd: num(ev.liquidity),
    volume_usd: num(ev.volume),
    volume_24h_usd: num(ev.volume24hr),
    end_date: ev.endDate || null,
    closed: !!ev.closed,
    outcomes: (ev.markets || []).slice(0, 10).map((m) => ({
      question: m.question,
      prices: parseOutcomes(m),
      liquidity_usd: num(m.liquidity),
      volume_24h_usd: num(m.volume24hr),
      last_trade_price: num(m.lastTradePrice),
      best_bid: num(m.bestBid),
      best_ask: num(m.bestAsk),
      end_date: m.endDateIso || null,
    })),
  }));
  const out = {
    generated_at: new Date().toISOString(),
    query,
    count: events.length,
    events,
    verdict: marketsVerdict(events),
    source: "polymarket gamma api (free, no key)",
    note: "Prices are per-outcome probabilities in USD (0–1). Refresh: 15 min cache.",
    cached: false,
  };
  marketsCache.set(key, out);
  return out;
}

// ---- /markets verdict: where is the lopsided conviction? ----
function marketsVerdict(events) {
  const reads = [];
  for (const ev of events || []) {
    for (const m of ev.outcomes || []) {
      const priced = (m.prices || []).filter((p) => p.price != null);
      if (!priced.length) continue;
      const top = priced.reduce((a, b) => (a.price > b.price ? a : b));
      const vol = num(m.volume_24h_usd) || 0;
      if ((top.price >= 0.75 || top.price <= 0.25) && vol >= 1000) {
        reads.push({
          question: m.question,
          lean: `${top.outcome} at ${Math.round(top.price * 100)}¢`,
          volume_24h_usd: vol,
          url: ev.url,
        });
      }
      if (reads.length >= 5) break;
    }
    if (reads.length >= 5) break;
  }
  const summary = reads.length
    ? `Conviction is lopsided in ${reads.length} market${reads.length > 1 ? "s" : ""} — sharpest: "${reads[0].question}" leaning ${reads[0].lean} on $${Math.round(reads[0].volume_24h_usd).toLocaleString()} 24h volume.`
    : "No lopsided high-conviction markets in this set — odds look balanced or volume is thin.";
  return {
    summary,
    conviction_reads: reads,
    disclaimer: "Heuristic read of public odds — not financial advice, not a betting tip.",
  };
}

// ---- /search: web search for agents ----
function parseDDG(html) {
  // DuckDuckGo's HTML endpoint: result links carry class "result__a" with
  // href="//duckduckgo.com/l/?uddg=<urlencoded target>&amp;rut=…", and each
  // result has a sibling "result__snippet" anchor. Pair them in order.
  const results = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snips = [...html.matchAll(snipRe)];
  for (let i = 0; i < links.length && results.length < 10; i++) {
    const rawHref = links[i][1].replace(/&amp;/g, "&");
    const m = rawHref.match(/[?&]uddg=([^&]+)/);
    if (!m) continue;
    let url;
    try { url = decodeURIComponent(m[1]); } catch { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripTags(links[i][2]) || url,
      url,
      snippet: snips[i] ? stripTags(snips[i][1]) : null,
    });
  }
  return results;
}

async function braveSearch(q) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  const j = await getJSON(
    `${BRAVE_API}?q=${encodeURIComponent(q)}&count=10&text_decorations=false`,
    { headers: { "X-Subscription-Token": key, Accept: "application/json" } }
  );
  const web = (j && j.web && j.web.results) || [];
  return web.slice(0, 10).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.description || null,
  }));
}

async function webSearch(q) {
  const query = String(q || "").trim();
  if (!query) throw badRequest('missing required query param "q" — try GET /search?q=solana+price');
  const key = query.toLowerCase();
  const hit = searchCache.get(key);
  if (hit) return { ...hit, cached: true };

  let results = null;
  let provider = "duckduckgo";
  try {
    const brave = await braveSearch(query);
    if (brave) { results = brave; provider = "brave"; }
  } catch (e) {
    console.error("brave search failed, falling back to duckduckgo:", e.message);
  }
  if (!results) {
    const html = await getText(DDG_HTML + encodeURIComponent(query));
    results = parseDDG(html);
  }
  const out = {
    generated_at: new Date().toISOString(),
    query,
    count: results.length,
    results,
    provider,
    note: provider === "duckduckgo"
      ? "Free DuckDuckGo fallback (no key). Set BRAVE_API_KEY on the server for the Brave Search upgrade path."
      : "Brave Search API.",
    cached: false,
  };
  searchCache.set(key, out);
  return out;
}

module.exports = { searchMarkets, webSearch };
