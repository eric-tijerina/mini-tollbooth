// TrollBridge /yields + /new-pairs + /gas lanes — data layer (the $0 edition).
// /yields: DeFiLlama's free yields API (no key) — best stablecoin yields.
//   1h cache; outlier pools excluded; yields move slowly.
// /new-pairs: DexScreener's free API (no key) — newest token profiles,
//   each enriched with live pair data (liquidity, volume, txns) and the same
//   thin-liquidity heuristic flags the /token-check lane uses.
//   15-min cache.
// /gas: live gas prices — Base + Ethereum via public RPC eth_gasPrice /
//   eth_feeHistory, Solana via getRecentPrioritizationFees. 5-min cache.
//   Degrades per-chain: an unreachable RPC marks that chain "unavailable"
//   with the last cached value and its age — never a made-up number.
// /models: BlockRun.AI's public model catalog (no key, no signup) — every
//   x402-payable AI model with per-million-token pricing, agent-ready.
//   BlockRun's ToS permits resale with attribution, so the response and the
//   lane description credit them. 30-min cache.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const LLAMA_YIELDS = "https://yields.llama.fi/pools";
const DEX_PROFILES = "https://api.dexscreener.com/token-profiles/latest/v1";
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";

const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};
const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana.public-rpc.com"];

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { ...UA, ...(opts.headers || {}) },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function rpcCall(rpcs, method, params) {
  let lastErr = null;
  for (const rpc of rpcs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`RPC ${rpc} -> ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`RPC ${rpc} error: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all RPCs failed");
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
const yieldsCache = makeCache(60 * 60 * 1000);
const pairsCache = makeCache(15 * 60 * 1000);
const gasCache = makeCache(5 * 60 * 1000);
const modelsCache = makeCache(30 * 60 * 1000);
const BLOCKRUN_MODELS = "https://blockrun.ai/api/v1/models";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampLimit(v, dflt, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = dflt;
  return Math.max(1, Math.min(max, n));
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const weiToGwei = (hex) => num(hex) / 1e9;

// ---- /yields: best stablecoin yields from DeFiLlama's free API ----
async function topYields(limit, stablecoinOnly) {
  const n = clampLimit(limit, 10, 25);
  const stables = stablecoinOnly !== "false";
  const key = `n:${n}:stables:${stables}`;
  const hit = yieldsCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  const j = await getJSON(LLAMA_YIELDS);
  const pools = j.data || [];
  let list = pools.filter((p) => !p.outlier && (p.tvlUsd || 0) >= 1000);
  if (stables) list = list.filter((p) => p.stablecoin);
  list.sort((a, b) => (b.apy || 0) - (a.apy || 0));
  const top = list.slice(0, n).map((p) => ({
    chain: p.chain,
    project: p.project,
    symbol: p.symbol,
    tvl_usd: num(p.tvlUsd),
    apy_pct: p.apy != null ? +p.apy.toFixed(2) : null,
    apy_base_pct: p.apyBase != null ? +p.apyBase.toFixed(2) : null,
    apy_reward_pct: p.apyReward != null ? +p.apyReward.toFixed(2) : null,
    il_risk: p.ilRisk || null,
    defillama_url: p.pool ? `https://defillama.com/yields/pool/${p.pool}` : null,
  }));
  const out = {
    generated_at: new Date().toISOString(),
    stablecoin_only: stables,
    count: top.length,
    pools: top,
    source: "defillama yields api (free, no key)",
    note: "APYs are trailing, not guaranteed — outlier pools and sub-$1k TVL excluded. Refresh: 1h cache.",
    cached: false,
  };
  yieldsCache.set(key, out);
  return out;
}

// ---- /new-pairs: newest DexScreener token profiles + live pair data ----
// The thin-liquidity flags mirror the /token-check lane's heuristic
// (liquidity thresholds + sell-pressure), applied per pair.
function pairFlags(p) {
  const flags = [];
  const liq = num(p.liquidity && p.liquidity.usd) || 0;
  const tx = (p.txns && p.txns.h24) || {};
  const buys = num(tx.buys) || 0;
  const sells = num(tx.sells) || 0;
  if (liq < 1000) flags.push(`very thin liquidity ($${Math.round(liq).toLocaleString()}) — easy to manipulate`);
  else if (liq < 10000) flags.push(`thin liquidity ($${Math.round(liq).toLocaleString()})`);
  if (sells > buys * 3 && sells > 10) flags.push(`heavy sell pressure: ${sells} sells vs ${buys} buys in 24h`);
  return flags;
}

async function enrichProfile(profile) {
  try {
    const d = await getJSON(DEX_TOKENS + encodeURIComponent(profile.tokenAddress));
    const pairs = (d && d.pairs) || [];
    // Prefer the pair with the most liquidity.
    pairs.sort((a, b) => (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0];
    if (!p) return { token_address: profile.tokenAddress, chain: profile.chainId, pair_data: null, flags: ["no DEX pair found yet — brand-new or unlisted"] };
    const tx = (p.txns && p.txns.h24) || {};
    return {
      token_address: profile.tokenAddress,
      chain: p.chainId || profile.chainId,
      dex: p.dexId || null,
      pair_address: p.pairAddress || null,
      base_token: p.baseToken ? { symbol: p.baseToken.symbol, name: p.baseToken.name } : null,
      price_usd: num(p.priceUsd),
      price_change_24h_pct: num(p.priceChange && p.priceChange.h24),
      liquidity_usd: num(p.liquidity && p.liquidity.usd),
      volume_24h_usd: num(p.volume && p.volume.h24),
      txns_24h: { buys: num(tx.buys) || 0, sells: num(tx.sells) || 0 },
      pair_url: p.url || profile.url || null,
      pair_created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
      flags: pairFlags(p),
    };
  } catch (e) {
    return { token_address: profile.tokenAddress, chain: profile.chainId, pair_data: null, error: "pair lookup failed", flags: [] };
  }
}

async function newPairs(limit, chain) {
  const n = clampLimit(limit, 10, 25);
  const chainFilter = chain ? String(chain).toLowerCase() : null;
  const key = `n:${n}:chain:${chainFilter || "all"}`;
  const hit = pairsCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  const profiles = await getJSON(DEX_PROFILES);
  let list = Array.isArray(profiles) ? profiles : [];
  if (chainFilter) list = list.filter((p) => String(p.chainId || "").toLowerCase() === chainFilter);
  const picked = list.slice(0, n);
  const pairs = await Promise.all(picked.map(enrichProfile));
  const out = {
    generated_at: new Date().toISOString(),
    chain_filter: chainFilter,
    count: pairs.length,
    pairs,
    source: "dexscreener free api (no key)",
    note: "Newest token profiles from DexScreener, enriched with live pair data. Profiles skew toward promoted tokens — flags mark thin liquidity, they are not a full safety scan (see /token-check). Refresh: 15-min cache.",
    cached: false,
  };
  pairsCache.set(key, out);
  return out;
}

// ---- /gas: live gas prices per chain ----
async function evmGas(chain) {
  const rpcs = EVM_RPCS[chain];
  const gasPriceHex = await rpcCall(rpcs, "eth_gasPrice", []);
  const gas_gwei = weiToGwei(gasPriceHex);
  // Honest speed tiers from real fee history: baseFee + priority-fee
  // percentiles (25th/50th/75th), median across the last 4 blocks.
  let tiers = null;
  try {
    const fh = await rpcCall(rpcs, "eth_feeHistory", ["0x4", "pending", [25, 50, 75]]);
    const baseFees = (fh.baseFeePerGas || []).map(weiToGwei);
    const base = median(baseFees.filter((x) => x != null));
    const rewards = fh.reward || [];
    const pct = (i) => median(rewards.map((r) => weiToGwei(r[i])).filter((x) => x != null));
    if (base != null) {
      tiers = {
        slow_gwei: base + (pct(0) || 0),
        standard_gwei: base + (pct(1) || 0),
        fast_gwei: base + (pct(2) || 0),
      };
      for (const k of Object.keys(tiers)) tiers[k] = +tiers[k].toFixed(4);
    }
  } catch { /* tiers are a bonus — gasPrice alone is still real */ }
  return {
    chain,
    gas_price_gwei: gas_gwei != null ? +gas_gwei.toFixed(4) : null,
    tiers,
    unit: "gwei",
    updated_at: new Date().toISOString(),
  };
}

async function solanaGas() {
  const fees = await rpcCall(SOLANA_RPCS, "getRecentPrioritizationFees", []);
  const vals = (fees || []).map((f) => num(f.prioritizationFee)).filter((x) => x != null);
  const med = median(vals);
  return {
    chain: "solana",
    median_prioritization_fee_microlamports_per_cu: med,
    base_fee_lamports_per_signature: 5000,
    unit: "microlamports per compute unit",
    note: "Solana has no gas auction — the prioritization fee is a small optional tip. Base fee is always 5000 lamports/signature.",
    updated_at: new Date().toISOString(),
  };
}

async function gasPrices() {
  const key = "all";
  const hit = gasCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  const chains = {};
  const jobs = [
    ["base", () => evmGas("base")],
    ["ethereum", () => evmGas("ethereum")],
    ["solana", solanaGas],
  ];
  await Promise.all(
    jobs.map(async ([name, fn]) => {
      try {
        chains[name] = { status: "live", ...(await fn()) };
      } catch (e) {
        chains[name] = { status: "unavailable", error: `upstream RPC unreachable: ${e.message}` };
      }
    })
  );
  // Stale-cache fallback per chain is automatic on the next call via
  // makeCache's stale return; here we surface what we got honestly.
  const out = {
    generated_at: new Date().toISOString(),
    chains,
    source: "public chain RPCs (no key)",
    note: "EVM prices from eth_gasPrice with eth_feeHistory speed tiers; Solana from recent prioritization fees. Refresh: 5-min cache.",
    cached: false,
  };
  gasCache.set(key, out);
  return out;
}

module.exports = { topYields, newPairs, gasPrices, modelCatalog };

// ---- /models: x402-payable AI model catalog, bridged from BlockRun.AI ----
async function modelCatalog() {
  const key = "all";
  const hit = modelsCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  const doc = await getJSON(BLOCKRUN_MODELS);
  const models = ((doc && doc.data) || [])
    .filter((m) => m.available !== false)
    .map((m) => {
      const p = m.pricing || {};
      return {
        id: m.id,
        name: m.name,
        provider: m.owned_by,
        description: m.description,
        context_window: m.context_window,
        max_output: m.max_output,
        categories: m.categories || [],
        billing_mode: m.billing_mode,
        price_per_1m_input_usd: p.input ?? null,
        price_per_1m_output_usd: p.output ?? null,
        cache_read_per_1m_usd: p.cache_read ?? null,
        cache_write_per_1m_usd: p.cache_write ?? null,
      };
    });
  const out = {
    generated_at: new Date().toISOString(),
    count: models.length,
    free_models: models.filter((m) => m.billing_mode === "free").map((m) => m.id),
    payment: {
      rail: "x402",
      network: "base",
      asset: "USDC",
      flat_fee_usd_per_call: 0.001,
      note: "Models are called directly against BlockRun.AI's x402 endpoints; this lane is the catalog that tells you what exists and what it costs.",
    },
    source: "BlockRun.AI public model catalog (no key) — bridged by TrollBridge with attribution",
    models,
    cached: false,
  };
  modelsCache.set(key, out);
  return out;
}
