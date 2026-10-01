// TrollBridge /regulatory-pack lane — data layer.
// Regulatory lookups for AI agents: FDA drug/food recall records via the keyless
// openFDA API. EPA ECHO has no keyless endpoint that responds from here, so
// agency="epa" currently returns a 400 pointing the caller at "fda".
// Honest limits: openFDA data is unvalidated (their own disclaimer) — this lane
// reports what the public record says, not medical or legal advice. $0 spend:
// keyless public APIs only.
const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent market-intel feed)";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
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

async function getJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd || "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || null;
}

function mapRecall(r) {
  return {
    product: r.product_description || null,
    firm: r.recalling_firm || null,
    reason: r.reason_for_recall || null,
    classification: r.classification || null,
    recall_date: fmtDate(r.recall_initiation_date),
  };
}

async function fdaLookup(query) {
  const q = encodeURIComponent(query);
  // Drug enforcement (recalls) first; fall back to food enforcement on no matches.
  const drug = await getJSON(`https://api.fda.gov/drug/enforcement.json?search=${q}&limit=10`);
  if (drug.status === 200 && drug.data && Array.isArray(drug.data.results)) {
    return {
      agency: "fda",
      query,
      count: drug.data.results.length,
      recalls: drug.data.results.map(mapRecall),
      note: "openFDA drug enforcement (recall) records — unvalidated public data, not medical or legal advice.",
    };
  }
  if (drug.status === 404 || (drug.data && drug.data.error && drug.data.error.code === "NOT_FOUND")) {
    const food = await getJSON(`https://api.fda.gov/food/enforcement.json?search=${q}&limit=10`);
    if (food.status === 200 && food.data && Array.isArray(food.data.results)) {
      return {
        agency: "fda",
        query,
        count: food.data.results.length,
        recalls: food.data.results.map(mapRecall),
        note: "openFDA food enforcement (recall) records — unvalidated public data, not medical or legal advice.",
      };
    }
    if (food.status === 404 || (food.data && food.data.error && food.data.error.code === "NOT_FOUND")) {
      return {
        agency: "fda",
        query,
        count: 0,
        recalls: [],
        note: "No matching drug or food recall records found in openFDA.",
      };
    }
  }
  throw new Error("regulatory feed unreachable — try again shortly");
}

async function regulatoryLookup(params) {
  const agency = String((params && params.agency) || "").trim().toLowerCase();
  const query = String((params && params.query) || "").trim();
  if (!agency) throw badRequest('missing required param: agency (usage: GET /regulatory-pack?agency=fda&query=...)');
  if (!query) throw badRequest('missing required param: query (usage: GET /regulatory-pack?agency=fda&query=...)');
  if (agency !== "fda" && agency !== "epa") throw badRequest('agency must be "fda" or "epa"');
  if (agency === "epa") throw badRequest('agency "epa" is temporarily unavailable — try "fda"');

  const key = `${agency}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.fresh) return hit.fresh;

  const out = await fdaLookup(query);
  cache.set(key, out);
  return out;
}

module.exports = { regulatoryLookup };
