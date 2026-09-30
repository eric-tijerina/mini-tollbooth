// roadpack.js — the combo meal from Mini's Agent Supply Store.
// GET /road-pack: gas + prices + DeFi movers + AI model catalog in one 5¢
// call. Reuses the existing lane modules (no reimplementation); the four
// sections run in parallel and fail independently with honest notes,
// /preflight-style. Heuristic reads of public data — not financial advice.
const defi = require("./defi-data");
const trader = require("./trader-data");

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  throw e;
}

function clampLimit(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 25) badRequest("limit must be an integer 1-25");
  return n;
}

function chainSummary(chains) {
  const out = {};
  for (const [name, c] of Object.entries(chains || {})) {
    if (!c || c.status !== "live") {
      out[name] = { status: (c && c.status) || "unavailable" };
      continue;
    }
    out[name] = { status: "live" };
    if (c.gas_price_gwei != null) out[name].gas_price_gwei = c.gas_price_gwei;
    if (c.median_prioritization_fee_microlamports_per_cu != null)
      out[name].median_prioritization_fee_microlamports_per_cu = c.median_prioritization_fee_microlamports_per_cu;
  }
  return out;
}

function pickFeatured(models) {
  const slim = (m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    billing_mode: m.billing_mode,
    price_per_1m_input_usd: m.price_per_1m_input_usd,
  });
  const free = models.filter((m) => m.billing_mode === "free").slice(0, 3).map(slim);
  if (free.length) return free;
  return models.slice(0, 3).map(slim);
}

function tripBrief(s) {
  const lines = [];
  lines.push(
    s.gas.status === "live"
      ? `⛽ ${s.gas.summary}`
      : "⛽ Gas stations are closed right now (upstreams unreachable) — check /gas later."
  );
  lines.push(
    s.prices.status === "live"
      ? `💹 ${s.prices.summary}`
      : "💹 Price board is down right now — check /prices later."
  );
  lines.push(
    s.defi_movers.status === "live"
      ? `🌊 ${s.defi_movers.summary}`
      : "🌊 DeFi waters uncharted right now (DeFiLlama unreachable) — check /defi later."
  );
  lines.push(
    s.models.status === "live"
      ? `🤖 ${s.models.count} AI models on the shelf, ${s.models.free_count} free to call.`
      : "🤖 Model shelf is empty right now — check /models later."
  );
  return lines;
}

async function roadPack(limit) {
  const n = clampLimit(limit, 10);
  const [gasR, pricesR, moversR, modelsR] = await Promise.allSettled([
    defi.gasPrices(),
    Promise.resolve().then(() => {
      const doc = trader.loadPrices();
      return trader.pricesVerdict(doc);
    }),
    defi.defiIntel("movers", 5),
    defi.modelCatalog(),
  ]);

  const sections = {};

  if (gasR.status === "fulfilled") {
    const g = gasR.value || {};
    sections.gas = {
      status: "live",
      cheapest: (g.verdict && g.verdict.cheapest) || null,
      summary: (g.verdict && g.verdict.summary) || "Gas data live.",
      chains: chainSummary(g.chains),
    };
  } else {
    sections.gas = { status: "unavailable", note: "gas upstreams unreachable — try the /gas lane shortly" };
  }

  if (pricesR.status === "fulfilled") {
    const v = pricesR.value || {};
    sections.prices = {
      status: "live",
      count: Math.min(n, (v.movers || []).length),
      movers: (v.movers || []).slice(0, n),
      summary: v.summary || "Price data live.",
    };
  } else {
    sections.prices = { status: "unavailable", note: "price feed unreachable — try the /prices lane shortly" };
  }

  if (moversR.status === "fulfilled") {
    const m = moversR.value || {};
    sections.defi_movers = {
      status: "live",
      gainers: (m.gainers || []).slice(0, 3),
      summary: (m.verdict && m.verdict.summary) || "Mover data live.",
    };
  } else {
    sections.defi_movers = { status: "unavailable", note: "DeFiLlama unreachable — try the /defi lane shortly" };
  }

  if (modelsR.status === "fulfilled") {
    const mc = modelsR.value || {};
    sections.models = {
      status: "live",
      count: mc.count || 0,
      free_count: (mc.free_models || []).length,
      featured: pickFeatured(mc.models || []),
    };
  } else {
    sections.models = { status: "unavailable", note: "model catalog unreachable — try the /models lane shortly" };
  }

  return {
    trip_brief: tripBrief(sections),
    sections,
    bundle: "road-pack",
    value_note: "Gas (2¢) + prices (2¢) + DeFi movers (2¢) + model catalog (2¢) = 8¢ of intel in one 5¢ call.",
    disclaimer: "Heuristic reads of public data — not financial advice.",
  };
}

module.exports = { roadPack };
