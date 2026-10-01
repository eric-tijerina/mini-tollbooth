// TrollBridge /prompt-cost lane — data layer (the $0 edition).
// Estimates what it costs to run a prompt through every model in the /models
// catalog (BlockRun.AI's public keyless catalog): heuristic token count x
// per-model input price, sorted cheapest-first. The optional ?model= filter
// prices a single model matched by id (fallback: name), case-insensitively.
//
// HEURISTIC ESTIMATE, NOT AN EXACT TOKENIZER COUNT: ~1 token per 4 chars for
// English/Latin text; CJK scripts and emoji tokenize much worse and are counted
// more densely. Real tokenizers (tiktoken/BPE) will give different numbers.
// Every response carries that wording.
const crypto = require("crypto");
const defi = require("./defi-data");

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (res.status === 404) return null; // catalog item gone, etc.
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- tiny TTL cache (keeps last value for graceful degradation) ----
function makeCache(ttlMs, max = 500) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) return { stale: e.v, age_ms: Date.now() - e.t };
      return { fresh: e.v };
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const costCache = makeCache(10 * 60 * 1000);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function roundCost(v) {
  if (!Number.isFinite(v) || v === 0) return 0;
  return Number(v.toPrecision(4)); // 4 significant figures; tiny values stay exact-ish
}
function cacheKey(text, model) {
  return crypto
    .createHash("sha256")
    .update(`${String(model || "").toLowerCase()}|${text}`)
    .digest("hex");
}

const MAX_CHARS = 50000;
const HEURISTIC_NOTE = "heuristic estimate, not an exact tokenizer count";
const SOURCE = "trollbridge /models catalog (BlockRun.AI data) + heuristic tokenizer";

// ---- heuristic tokenizer ----
// English/Latin text: ~1 token per 4 chars. CJK scripts tokenize much worse
// (often ~1 token per char or more), so CJK code points are weighted ~1.2
// tokens each; everything else goes through the /4 rule. Honest by label.
const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7a3]/u;
function estimateTokens(text) {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total++; // iterates code points, so emoji/astral chars count once
    if (CJK_RE.test(ch)) cjk++;
  }
  return Math.max(1, Math.ceil(cjk * 1.2 + (total - cjk) / 4));
}

function findModel(models, q) {
  const needle = String(q).toLowerCase().trim();
  return (
    models.find((m) => String(m.id || "").toLowerCase().includes(needle)) ||
    models.find((m) => String(m.name || "").toLowerCase().includes(needle)) ||
    null
  );
}

function fmtTok(n) {
  return n.toLocaleString("en-US");
}

async function estimatePromptCost(text, model) {
  if (typeof text !== "string" || !text.trim()) {
    throw badRequest("text is required: pass the prompt as ?text=<prompt>");
  }
  if (text.length > MAX_CHARS) {
    throw badRequest(
      `prompt too long: max ${MAX_CHARS} characters, got ${text.length}`
    );
  }
  const wantModel =
    model == null || String(model).trim() === "" ? null : String(model).trim();

  const key = cacheKey(text, wantModel);
  const hit = costCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  // Live catalog call (keyless, own 30-min cache inside defi-data).
  const catalog = await defi.modelCatalog();
  const models = Array.isArray(catalog.models) ? catalog.models : [];

  let picked = models;
  if (wantModel) {
    const m = findModel(models, wantModel);
    if (!m)
      throw badRequest(
        `model not found in catalog: "${wantModel}" (matched case-insensitively against id, then name)`
      );
    picked = [m];
  }

  const estimated_tokens = estimateTokens(text);
  const chars = [...text].length;

  const costs = [];
  for (const m of picked) {
    let price = num(m.price_per_1m_input_usd);
    if (price == null && m.billing_mode === "free") price = 0;
    if (price == null) continue; // no numeric input price — skip, never invent one
    costs.push({
      id: m.id,
      name: m.name,
      provider: m.provider,
      price_per_1m_input_usd: price,
      est_cost_usd: roundCost((estimated_tokens / 1e6) * price),
    });
  }
  costs.sort(
    (a, b) => a.est_cost_usd - b.est_cost_usd || String(a.id).localeCompare(String(b.id))
  );

  const cheapest = costs.length
    ? { id: costs[0].id, est_cost_usd: costs[0].est_cost_usd }
    : null;

  const summary = wantModel
    ? cheapest
      ? `~${fmtTok(estimated_tokens)} tokens on ${cheapest.id} at ~$${cheapest.est_cost_usd}. Heuristic estimate, not an exact tokenizer count.`
      : `~${fmtTok(estimated_tokens)} tokens. ${wantModel} has no input price in the catalog. Heuristic estimate, not an exact tokenizer count.`
    : cheapest
      ? `~${fmtTok(estimated_tokens)} tokens across ${costs.length} priced models. Cheapest: ${cheapest.id} at ~$${cheapest.est_cost_usd}. Heuristic estimate, not an exact tokenizer count.`
      : `~${fmtTok(estimated_tokens)} tokens. No models with input pricing in the catalog right now. Heuristic estimate, not an exact tokenizer count.`;

  const out = {
    estimated_tokens,
    chars,
    pricing_note: HEURISTIC_NOTE,
    costs,
    cheapest,
    summary,
    note: "Token count: ~1 token per 4 chars of English/Latin text; CJK scripts and emoji counted more densely. Costs = estimated_tokens / 1,000,000 x catalog input price. Free (price 0) models cost $0. Refresh: 10-min cache.",
    source: SOURCE,
    cached: false,
  };
  costCache.set(key, out);
  return out;
}

module.exports = { estimatePromptCost, PROMPT_COST_MAX_CHARS: MAX_CHARS };
