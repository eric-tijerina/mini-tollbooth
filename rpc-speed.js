// TrollBridge /rpc-speed lane — data layer (the $0 edition).
// Live latency race across genuinely PUBLIC, keyless RPC endpoints — no keys,
// no signup. One JSON-RPC call per endpoint (eth_getBlockByNumber "latest" on
// EVM chains, getSlot on Solana), timed with Date.now(), ranked fastest-first.
// Failures are reported honestly ({status:"timeout"|"error", ms:null}) and sort
// last. A 10-minute in-memory cache keeps this from hammering free endpoints.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const TIMEOUT_MS = 8000;
const CONCURRENCY = 3;

// Verified keyless by live test (2026-10-01). Dropped as NOT keyless:
//   https://rpc.ankr.com/eth         -> "Unauthorized: authenticate with an API key"
//   https://rpc.ankr.com/solana      -> 403 "API key is not allowed to access blockchain"
//   https://solana.blockpi.network/v1/rpc/public -> "Apikey not found"
//   https://solana.public-rpc.com    -> unreachable (DNS sinkhole from test host)
//   https://rpc.solanatracker.io/public?api-key=public -> timed out
const RPC_ENDPOINTS = {
  base: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base.meowrpc.com",
    "https://base.public.blockpi.network/v1/rpc/public",
  ],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://eth.meowrpc.com",
  ],
  solana: [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ],
};

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
const speedCache = makeCache(10 * 60 * 1000);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

async function measureEndpoint(url, isSolana) {
  const body = isSolana
    ? { jsonrpc: "2.0", id: 1, method: "getSlot" }
    : { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...UA },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const ms = Date.now() - start;
    if (!res.ok) return { url, ms: null, status: "error", block_or_slot: null };
    const j = await res.json().catch(() => null);
    if (!j || j.error || j.result === undefined || j.result === null)
      return { url, ms: null, status: "error", block_or_slot: null };
    const block_or_slot = isSolana
      ? (typeof j.result === "number" ? j.result : null)
      : (j.result && j.result.number ? parseInt(j.result.number, 16) : null);
    if (block_or_slot === null) return { url, ms: null, status: "error", block_or_slot: null };
    return { url, ms, status: "ok", block_or_slot };
  } catch (e) {
    return { url, ms: null, status: e.name === "AbortError" ? "timeout" : "error", block_or_slot: null };
  } finally {
    clearTimeout(t);
  }
}

// Small concurrency pool so we don't hammer free endpoints.
async function race(urls, isSolana) {
  const results = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      results[i] = await measureEndpoint(urls[i], isSolana);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return results;
}

async function rpcSpeed(chain) {
  const ch = (chain || "base").toLowerCase();
  if (!RPC_ENDPOINTS[ch]) throw badRequest("chain must be base, ethereum, or solana");

  const cached = speedCache.get(ch);
  if (cached && cached.fresh) return { ...cached.fresh, cached: true };

  const isSolana = ch === "solana";
  const urls = RPC_ENDPOINTS[ch];
  const endpoints = await race(urls, isSolana);
  endpoints.sort((a, b) => {
    if (a.status === "ok" && b.status !== "ok") return -1;
    if (b.status === "ok" && a.status !== "ok") return 1;
    if (a.status !== "ok" && b.status !== "ok") return 0;
    return a.ms - b.ms;
  });

  const ok = endpoints.filter((e) => e.status === "ok");
  const fastest = ok.length ? { url: ok[0].url, ms: ok[0].ms } : null;
  const summary = ok.length
    ? `${ok.length} of ${urls.length} endpoints answered; fastest is ${fastest.url} at ${fastest.ms}ms`
    : `0 of ${urls.length} endpoints answered — all timed out or errored`;

  const out = {
    chain: ch,
    measured_at: new Date().toISOString(),
    endpoints,
    fastest,
    summary,
    source: "live measurement from the bridge host (Render)",
    note: "single-sample latency; your mileage may vary",
    cached: false,
  };
  speedCache.set(ch, out);
  return out;
}

module.exports = { rpcSpeed, RPC_SPEED_CHAINS: Object.keys(RPC_ENDPOINTS) };
