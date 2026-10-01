// TrollBridge /sage lane — data layer.
// "Specialist in all fields": multi-source fact aggregation with a cited
// verdict. Routes by domain:
//   finance → SEC EDGAR companyfacts (via sec-facts.js) + Wikipedia cross-check
//   crypto  → DexScreener venue consensus (price, liquidity, volume, momentum)
//   general → Wikipedia REST summary + references
// Keyless upstreams only. Stateless, content-in/verdict-out. Every number is
// cited; confidence says whether sources agree. Multi-source brief, not a
// guarantee.
const { secFacts } = require("./sec-facts");

const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent knowledge feed)";
const DEX_SEARCH = (q) => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
const WIKI_SUMMARY = (title) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
const WIKI_OPENSEARCH = (q) => `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&format=json`;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- tiny TTL cache (5 min) ----
function makeCache(ttlMs, max = 300) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) return { stale: e.v };
      return { fresh: e.v };
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const sageCache = makeCache(5 * 60 * 1000, 300);

async function getJSON(url, timeoutMs = 10000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctrl.signal });
    if (!res.ok) {
      const e = new Error(`GET ${url} -> ${res.status}`);
      e.httpStatus = res.status;
      throw e;
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- domain: finance (US ticker) ----
const TICKER_Q = /^([A-Za-z]{1,5})(?:\s+(revenue|earnings|net\s*income|income|eps|assets|debt|stock|shares?|price|10-?k|financials|fundamentals|market\s*cap))?\s*$/i;

async function tryFinance(q) {
  const m = q.match(TICKER_Q);
  if (!m) return null;
  const ticker = m[1].toUpperCase();
  let sec;
  try {
    sec = await secFacts(ticker);
  } catch (e) {
    if (e.statusCode === 400) return null; // not a real ticker — fall through
    throw e;
  }
  const facts = [];
  const latest = {};
  for (const f of sec.facts || []) {
    const a0 = (f.annual || [])[0];
    if (a0) {
      latest[f.label] = a0.val;
      facts.push({ label: f.label, value: fmtMoney(a0.val), source: "SEC EDGAR companyfacts", url: sec.sources.companyfacts_json });
    }
  }
  // Cross-check: does Wikipedia's company profile agree on revenue scale?
  let confidence = "single-source";
  let wikiNote = null;
  let wikiUrl = null;
  try {
    const title = String(sec.company || "").replace(/ /g, "_");
    const wiki = await getJSON(WIKI_SUMMARY(title));
    wikiUrl = wiki?.content_urls?.desktop?.page || null;
    const text = wiki?.extract || "";
    const dm = text.match(/\$([\d.,]+)\s*(trillion|billion|million)/i);
    if (dm && latest["Total revenue"]) {
      const mult = { trillion: 1e12, billion: 1e9, million: 1e6 }[dm[2].toLowerCase()];
      const wikiRev = parseFloat(dm[1].replace(/,/g, "")) * mult;
      const secRev = latest["Total revenue"];
      const ratio = wikiRev / secRev;
      if (ratio > 0.6 && ratio < 1.6) {
        confidence = "consensus";
        wikiNote = `Wikipedia's company profile cites revenue ≈ ${fmtMoney(wikiRev)}, in line with the SEC filing (${fmtMoney(secRev)}).`;
      } else {
        confidence = "conflicting";
        wikiNote = `Wikipedia cites revenue ≈ ${fmtMoney(wikiRev)} but the latest SEC 10-K says ${fmtMoney(secRev)} — figures may cover different fiscal years.`;
      }
    }
  } catch (e) { /* Wikipedia optional — SEC stands alone */ }

  const rev = latest["Total revenue"] ? `FY revenue ${fmtMoney(latest["Total revenue"])}` : "revenue n/a";
  const inc = latest["Net income (loss)"] != null ? `, net income ${fmtMoney(latest["Net income (loss)"])}` : "";
  const answer = `${sec.company} (${sec.ticker}): ${rev}${inc}, from the latest SEC 10-K filing. Numbers are XBRL-tagged, filed data — not estimates.`;
  const sources = [sec.sources.companyfacts_json, sec.sources.edgar_filings];
  if (wikiUrl) sources.push(wikiUrl);
  return {
    domain: "finance",
    answer,
    facts,
    confidence,
    sources,
    verdict: confidence === "consensus"
      ? `consensus: SEC filing and Wikipedia agree on revenue scale${wikiNote ? " — " + wikiNote : ""}`
      : confidence === "conflicting"
        ? `conflicting sources: ${wikiNote}`
        : "single-source: SEC EDGAR companyfacts (authoritative for US filers)",
  };
}

// Major crypto aliases resolve to real spot prices first (DeFiLlama), so
// "ETH" means Ethereum, not the ETH stock ticker, and "bitcoin" means BTC.
const MAJORS = { BTC: "bitcoin", BITCOIN: "bitcoin", ETH: "ethereum", ETHEREUM: "ethereum", SOL: "solana", SOLANA: "solana" };
// Accepted DEX symbols per major — keeps wrapped/synthetic variants, drops
// same-name memecoins on random chains.
const MAJOR_SYMBOLS = { bitcoin: ["BTC", "WBTC", "CBBTC"], ethereum: ["ETH", "WETH"], solana: ["SOL", "WSOL"] };
const LLAMA_SPOT = (id) => `https://coins.llama.fi/prices/current/coingecko:${id}`;

// ---- domain: crypto (DexScreener venue consensus) ----
function rankVenues(pairs, q) {
  // Group by base token address → rank groups by total liquidity, with an
  // exact-symbol-match boost so "bitcoin" finds real BTC liquidity (WBTC),
  // not the memecoin with the same letters.
  const byToken = new Map();
  for (const p of pairs) {
    const key = `${p.chainId}:${p.baseToken?.address || p.baseToken?.symbol}`;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key).push(p);
  }
  const qSym = q.trim().toUpperCase();
  const scored = [...byToken.entries()].map(([key, ps]) => {
    const liq = ps.reduce((s, p) => s + Number(p.liquidity?.usd || 0), 0);
    const sym = String(ps[0].baseToken?.symbol || "").toUpperCase();
    const exact = sym === qSym || sym === `W${qSym}` || `W${sym}` === qSym;
    return { key, ps, score: liq * (exact ? 1000 : 1), liq };
  }).sort((a, b) => b.score - a.score);
  const { ps: venues } = scored[0];
  return venues;
}

function buildCryptoBrief(venues, q, spot) {
  const sym = venues[0].baseToken?.symbol || q.toUpperCase();
  const name = venues[0].baseToken?.name || sym;
  const chainId = venues[0].chainId;
  const prices = venues.map((p) => Number(p.priceUsd)).filter(Number.isFinite);
  const px = median(prices);
  const spread = prices.length > 1 ? (Math.max(...prices) - Math.min(...prices)) / px : 0;
  const liq = venues.reduce((s, p) => s + Number(p.liquidity?.usd || 0), 0);
  const vol = venues.reduce((s, p) => s + Number(p.volume?.h24 || 0), 0);
  const chg = Number(venues[0].priceChange?.h24);
  const momentum = Number.isFinite(chg) ? (chg >= 10 ? "hot" : chg <= -10 ? "cooling" : "flat") : "unknown";
  const facts = [];
  let confidence, verdict, answer;
  const dexUrl = venues[0].url;
  if (spot && Number.isFinite(spot.price)) {
    // Major: authoritative spot + DEX venue cross-check
    const dev = Math.abs(px - spot.price) / spot.price;
    facts.push({ label: "Spot price (USD)", value: `$${spot.price}`, source: "DeFiLlama", url: "https://defillama.com" });
    facts.push({ label: "DEX venue price (USD)", value: `$${px}`, source: `DexScreener — ${venues.length} venue(s)`, url: dexUrl });
    confidence = dev < 0.03 ? "consensus" : dev < 0.1 ? "single-source" : "conflicting";
    verdict = confidence === "consensus"
      ? `consensus: DeFiLlama spot and DEX venues agree within ${(dev * 100).toFixed(1)}%`
      : confidence === "conflicting"
        ? `conflicting: DEX venues deviate ${(dev * 100).toFixed(1)}% from spot — check which venue`
        : "single-source: DeFiLlama spot (DEX venue data thin)";
    answer = `${spot.name} (${spot.symbol}): spot $${spot.price} (DeFiLlama), DEX venues median $${px} across ${venues.length} venue(s), 24h ${Number.isFinite(chg) ? chg.toFixed(2) + "%" : "n/a"}, liquidity ${fmtMoney(liq)}, volume ${fmtMoney(vol)}. Momentum: ${momentum}.`;
  } else {
    confidence = venues.length >= 2 && spread < 0.05 ? "consensus" : venues.length >= 2 && spread >= 0.15 ? "conflicting" : "single-source";
    verdict = confidence === "consensus"
      ? `consensus: ${venues.length} venues agree within ${(spread * 100).toFixed(1)}% on price`
      : confidence === "conflicting"
        ? `conflicting: venue prices spread ${(spread * 100).toFixed(1)}% — thin or fragmented liquidity`
        : "single-source: one DEX venue with liquidity found";
    answer = `${name} (${sym}) on ${chainId}: $${px} across ${venues.length} DEX venue(s), 24h ${Number.isFinite(chg) ? chg.toFixed(2) + "%" : "n/a"}, liquidity ${fmtMoney(liq)}, volume ${fmtMoney(vol)}. Momentum: ${momentum}.`;
    facts.push({ label: "Price (USD)", value: `$${px}`, source: `DexScreener — ${venues.length} DEX venue(s)`, url: dexUrl });
  }
  facts.push({ label: "Total liquidity", value: fmtMoney(liq), source: "DexScreener", url: dexUrl });
  facts.push({ label: "24h volume", value: fmtMoney(vol), source: "DexScreener", url: dexUrl });
  if (Number.isFinite(chg)) facts.push({ label: "24h change", value: `${chg.toFixed(2)}%`, source: "DexScreener", url: dexUrl });
  facts.push({ label: "Momentum", value: momentum, source: "TrollBridge heuristic on DexScreener 24h change", url: dexUrl });
  const sources = ["https://defillama.com", ...new Set(venues.slice(0, 5).map((p) => p.url).filter(Boolean))];
  return { domain: "crypto", answer, facts, confidence, sources, verdict };
}

async function dexVenues(q) {
  let data;
  try {
    data = await getJSON(DEX_SEARCH(q));
  } catch (e) {
    return null;
  }
  const pairs = (data?.pairs || []).filter((p) => p.priceUsd && Number(p.liquidity?.usd) > 0);
  if (!pairs.length) return null;
  return rankVenues(pairs, q);
}

async function tryCryptoMajor(q) {
  const id = MAJORS[q.trim().toUpperCase()];
  if (!id) return null;
  let spot = null;
  try {
    const d = await getJSON(LLAMA_SPOT(id));
    const c = d?.coins?.[`coingecko:${id}`];
    if (c && Number.isFinite(c.price)) spot = { price: c.price, symbol: c.symbol || id.toUpperCase(), name: id[0].toUpperCase() + id.slice(1) };
  } catch (e) { /* spot optional */ }
  const venuesAll = await dexVenues(q);
  let venues = venuesAll;
  if (venuesAll) {
    const ok = MAJOR_SYMBOLS[id];
    let filtered = venuesAll.filter((p) => ok.includes(String(p.baseToken?.symbol || "").toUpperCase()));
    // Drop venues whose price is nonsense vs spot (stale/dead pools).
    if (spot && filtered.length) {
      const sane = filtered.filter((p) => {
        const px = Number(p.priceUsd);
        return Number.isFinite(px) && Math.abs(px - spot.price) / spot.price < 0.1;
      });
      if (sane.length) filtered = sane;
      else filtered = [];
    }
    if (filtered.length) venues = filtered;
    else venues = null;
  }
  if (!venues && !spot) return null;
  if (!venues) {
    return {
      domain: "crypto",
      answer: `${spot.name} (${spot.symbol}): spot $${spot.price} (DeFiLlama). No liquid DEX venues found right now.`,
      facts: [{ label: "Spot price (USD)", value: `$${spot.price}`, source: "DeFiLlama", url: "https://defillama.com" }],
      confidence: "single-source",
      sources: ["https://defillama.com"],
      verdict: "single-source: DeFiLlama spot only",
    };
  }
  return buildCryptoBrief(venues, q, spot);
}

async function tryCrypto(q) {
  const venues = await dexVenues(q);
  if (!venues) return null;
  return buildCryptoBrief(venues, q, null);
}

// ---- domain: general (Wikipedia) ----
async function generalBrief(q) {
  let title = q;
  try {
    const os = await getJSON(WIKI_OPENSEARCH(q));
    if (os && os[1] && os[1][0]) title = os[1][0];
  } catch (e) { /* fall back to raw query */ }
  let page;
  try {
    page = await getJSON(WIKI_SUMMARY(title));
  } catch (e) {
    if (e.httpStatus === 404) throw badRequest(`no knowledge found for "${q}" — try a company ticker (finance), a token name (crypto), or a clearer topic`);
    throw e;
  }
  const extract = (page.extract || "").slice(0, 700);
  const facts = [
    { label: "Topic", value: page.title || q, source: "Wikipedia", url: page?.content_urls?.desktop?.page || null },
  ];
  if (page.description) facts.push({ label: "Description", value: page.description, source: "Wikipedia", url: page?.content_urls?.desktop?.page || null });
  const answer = extract ? `${page.title}: ${extract}${extract.length >= 700 ? "…" : ""}` : `${page.title} — see the Wikipedia article for the full brief.`;
  return {
    domain: "general",
    answer,
    facts,
    confidence: "single-source",
    sources: [page?.content_urls?.desktop?.page].filter(Boolean),
    verdict: "single-source: Wikipedia summary with article references — cross-check before acting on it",
  };
}

// ---- main entry ----
async function sage(query) {
  const q = String(query || "").trim();
  if (!q) throw badRequest('missing query — usage: GET /sage?q=NVDA or ?q=bitcoin or ?q=photosynthesis (also accepts ?topic=)');
  if (q.length > 200) throw badRequest("query too long — keep it under 200 characters");
  const key = `sage:${q.toLowerCase()}`;
  const hit = sageCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  // Route: major crypto first (so "ETH" means Ethereum, not the stock
  // ticker), then finance tickers, then DEX search, then general knowledge.
  let out = await tryCryptoMajor(q);
  if (!out) out = await tryFinance(q);
  if (!out) out = await tryCrypto(q);
  if (!out) out = await generalBrief(q);

  const result = {
    generated_at: new Date().toISOString(),
    cached: false,
    lane: "/sage",
    query: q,
    ...out,
    note: "Multi-source brief with cited facts — not a guarantee. Confidence tells you whether independent sources agree.",
  };
  sageCache.set(key, result);
  return result;
}

module.exports = { sage };
