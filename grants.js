// TrollBridge /grants lane — data layer.
// Federal grant search off the free Grants.gov API (no key, $0 spend).
// Searches posted/forecasted/closed/archived opportunities by keyword;
// award ceilings come from per-opportunity detail lookups. Heuristic
// screen, not a grant advisor — always verify on grants.gov before applying.
const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent market-intel feed)";

const SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity";

const STATUSES = ["forecasted", "posted", "closed", "archived"];

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// Upstream failure: plain Error, no statusCode (server maps to 502).
function upstreamError(msg) {
  return new Error(msg);
}

// ---- tiny TTL cache (1h) ----
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
const cache = makeCache(60 * 60 * 1000);

async function postJSON(url, body, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function validate(params) {
  const p = params || {};
  const kw = String(p.keyword || "").trim();
  if (kw.length < 2) throw badRequest("missing/invalid param: keyword (min 2 chars; usage: GET /grants?keyword=solar)");
  const st = String(p.status || "posted").trim().toLowerCase();
  if (!STATUSES.includes(st)) throw badRequest(`invalid status (usage: status=${STATUSES.join("|")})`);
  const ag = String(p.agency || "").trim();
  return { keyword: kw, agency: ag, status: st };
}

function normCeiling(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "none") return null;
  return s;
}

async function searchGrants(params) {
  const { keyword, agency, status } = validate(params);
  const key = `${keyword}|${agency}|${status}`;
  const hit = cache.get(key);
  if (hit && hit.fresh) return hit.fresh;

  let res;
  try {
    res = await postJSON(SEARCH_URL, { keyword, oppStatuses: status, agencies: agency, rows: 10 });
  } catch (e) {
    throw upstreamError("grants feed unreachable — try again shortly");
  }
  if (!res || res.errorcode !== 0 || !res.data || !Array.isArray(res.data.oppHits)) {
    throw upstreamError("grants feed unreachable — try again shortly");
  }

  const hits = res.data.oppHits.slice(0, 10);

  // Award ceilings live on the detail endpoint — fetch in parallel, best-effort.
  // A failed detail lookup yields award_ceiling: null, never invented data.
  const ceilings = await Promise.all(
    hits.map(async (h) => {
      try {
        const d = await postJSON(DETAIL_URL, { opportunityId: String(h.id) }, 8000);
        const syn = d && d.data && d.data.synopsis;
        return syn ? normCeiling(syn.awardCeiling) : null;
      } catch (e) {
        return null;
      }
    })
  );

  const opportunities = hits.map((h, i) => ({
    title: h.title || null,
    number: h.number || null,
    agency: h.agency || h.agencyCode || null,
    close_date: h.closeDate || null,
    award_ceiling: ceilings[i],
    url: h.id ? `https://www.grants.gov/search-results-detail/${h.id}` : null,
  }));

  const out = {
    keyword,
    count: Number(res.data.hitCount) || opportunities.length,
    opportunities,
  };
  cache.set(key, out);
  return out;
}

module.exports = { searchGrants };
