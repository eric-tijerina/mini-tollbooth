// TrollBridge /sec-facts lane — data layer.
// Ticker -> cited SEC EDGAR XBRL company facts: revenue, net income,
// total assets, EPS for recent annual (10-K) and quarterly (10-Q) periods.
// Keyless EDGAR API (company_tickers.json + companyfacts), proper bot
// User-Agent per SEC fair-access rules. Deterministic — every number is
// cited to its filing; nothing is estimated or hallucinated.
const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent market-intel feed)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const companyFactsUrl = (cik10) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
const edgarCompanyUrl = (cik) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(cik).padStart(10, "0")}&type=10-K&count=10`;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- tiny TTL cache ----
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
const tickerCache = makeCache(24 * 60 * 60 * 1000, 50);
const factsCache = makeCache(6 * 60 * 60 * 1000, 200);

async function getJSON(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function resolveTicker(ticker) {
  const key = ticker.toUpperCase();
  const hit = tickerCache.get(key);
  if (hit && hit.fresh) return hit.fresh;
  const data = await getJSON(TICKERS_URL);
  const rows = Object.values(data || {});
  const row = rows.find((r) => String(r.ticker || "").toUpperCase() === key);
  if (!row) throw badRequest(`ticker "${ticker}" not found in SEC company tickers — check the symbol (US-listed companies only)`);
  const out = { cik: Number(row.cik_str), cik10: String(row.cik_str).padStart(10, "0"), name: row.title };
  tickerCache.set(key, out);
  return out;
}

// Concepts we pull, in us-gaap. Revenue has two common tags; try both.
const CONCEPTS = [
  { concept: "Revenues", label: "Total revenue", unit: "USD" },
  { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", label: "Revenue (alt tag)", unit: "USD", fallback: true },
  { concept: "NetIncomeLoss", label: "Net income (loss)", unit: "USD" },
  { concept: "Assets", label: "Total assets", unit: "USD" },
  { concept: "EarningsPerShareBasic", label: "EPS (basic)", unit: "USD/shares" },
  { concept: "EarningsPerShareDiluted", label: "EPS (diluted)", unit: "USD/shares" },
];

function daysBetween(a, b) {
  const t = Date.parse(b) - Date.parse(a);
  return Number.isFinite(t) ? Math.round(t / 86400000) : 0;
}

// Duration-based period detection — robust across frame-tagging quirks
// (instant concepts like Assets carry "I"-suffixed or empty frames; some
// filers put quarterly breakdowns inside 10-Ks). Annual = ~1yr duration
// (or instant / CY#### frame); quarterly = ~90d duration (or CY####Q# frame).
function pickPeriods(entries, wantAnnual, wantQ) {
  const annual = [];
  const quarterly = [];
  const sorted = [...entries]
    .filter((e) => e.form === "10-K" || e.form === "10-Q")
    .sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.filed).localeCompare(String(a.filed)));
  const seenA = new Set();
  const seenQ = new Set();
  for (const e of sorted) {
    const dur = e.start ? daysBetween(e.start, e.end) : 0;
    const isInstant = !e.start || dur <= 1;
    const frame = e.frame || "";
    if (e.form === "10-K" && annual.length < wantAnnual && !seenA.has(e.end)) {
      if (isInstant || dur >= 340 || /^CY\d{4}$/.test(frame)) {
        seenA.add(e.end);
        annual.push({ end: e.end, val: e.val, form: e.form, filed: e.filed, frame: frame || null });
      }
    } else if (e.form === "10-Q" && quarterly.length < wantQ && !seenQ.has(e.end)) {
      if (isInstant || (dur >= 70 && dur <= 115) || /^CY\d{4}Q[1-4]/.test(frame)) {
        seenQ.add(e.end);
        quarterly.push({ end: e.end, val: e.val, form: e.form, filed: e.filed, frame: frame || null });
      }
    }
    if (annual.length >= wantAnnual && quarterly.length >= wantQ) break;
  }
  return { annual, quarterly };
}

async function secFacts(ticker) {
  const tk = (ticker || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(tk)) throw badRequest("ticker must be a US stock symbol like AAPL or BRK.B");
  const cacheKey = `facts:${tk}`;
  const hit = factsCache.get(cacheKey);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  const { cik, cik10, name } = await resolveTicker(tk);
  let company;
  try {
    company = await getJSON(companyFactsUrl(cik10));
  } catch (e) {
    throw new Error(`EDGAR companyfacts unreachable for CIK ${cik10}: ${e.message}`);
  }
  const gaap = (company.facts && company.facts["us-gaap"]) || {};

  const facts = [];
  // Revenue: filers use either tag — take whichever has the freshest annual data.
  const revenueCands = [];
  for (const c of CONCEPTS.filter((c) => c.concept === "Revenues" || c.concept === "RevenueFromContractWithCustomerExcludingAssessedTax")) {
    const node = gaap[c.concept];
    if (!node || !node.units) continue;
    const entries = node.units[c.unit] || node.units["USD"] || [];
    if (!entries.length) continue;
    const picked = pickPeriods(entries, 5, 4);
    if (!picked.annual.length && !picked.quarterly.length) continue;
    revenueCands.push({ c, picked });
  }
  revenueCands.sort((a, b) => String((b.picked.annual[0] || {}).end || "").localeCompare(String((a.picked.annual[0] || {}).end || "")));
  if (revenueCands.length) {
    const { c, picked } = revenueCands[0];
    facts.push({ concept: c.concept, label: "Total revenue", unit: c.unit, ...picked });
  }
  for (const c of CONCEPTS) {
    if (c.concept === "Revenues" || c.concept === "RevenueFromContractWithCustomerExcludingAssessedTax") continue;
    const node = gaap[c.concept];
    if (!node || !node.units) continue;
    const entries = node.units[c.unit] || node.units["USD"] || [];
    if (!entries.length) continue;
    const picked = pickPeriods(entries, 5, 4);
    if (!picked.annual.length && !picked.quarterly.length) continue;
    facts.push({ concept: c.concept, label: c.label, unit: c.unit, ...picked });
  }

  const out = {
    generated_at: new Date().toISOString(),
    cached: false,
    lane: "/sec-facts",
    ticker: tk,
    company: name || company.entityName,
    cik: cik10,
    facts,
    sources: {
      companyfacts_json: companyFactsUrl(cik10),
      edgar_filings: edgarCompanyUrl(cik),
    },
    note: "Every number is XBRL-tagged data filed with the SEC — cited to its form and filing date, never estimated. Annual = 10-K fiscal-year frames; quarterly = 10-Q frames.",
  };
  factsCache.set(cacheKey, out);
  return out;
}

module.exports = { secFacts };
