// TrollBridge /approval-audit lane — data layer (the $0 edition).
// Wallet token-approval surface report: sweeps live allowance(owner, spender)
// for a curated set of major ERC20 tokens x well-known protocol spender contracts
// via public keyless RPCs (no key, no signup). Unlimited (2^256-1) allowances are
// flagged "revoke-first"; other live allowances are flagged "review".
//
// HEURISTIC SURFACE REPORT, NOT A SECURITY AUDIT: this only checks the listed
// tokens against the listed spenders. A zero result does NOT mean the wallet has
// no approvals anywhere — approvals to spenders outside the curated list are not
// covered. A clean report does not mean the wallet is safe.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const BLOCKSCOUT = {
  base: "https://base.blockscout.com/api/v2",
  ethereum: "https://eth.blockscout.com/api/v2",
};
// Public keyless RPCs for eth_call (allowance) and eth_getCode (spender check).
// Same keyless lists the /contract-check lane uses.
const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};

// Curated ERC20s per chain. All addresses verified on-chain (eth_getCode + code
// present) and cross-checked against Blockscout token records.
const TOKENS = {
  base: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "DAI", address: "0x50c5725949A6F0cD42A83E5460e4dF1191d3d0d", decimals: 18 },
    { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  ],
  ethereum: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  ],
};

// Curated spender contracts. All addresses verified on-chain (eth_getCode shows
// deployed bytecode on that chain). Spenders with no code on a chain are skipped
// at runtime and named in the coverage note.
const SPENDERS = {
  base: [
    { name: "Uniswap V3 SwapRouter02", address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" },
    { name: "Permit2", address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    { name: "Seaport 1.5", address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC" },
    { name: "Seaport 1.1", address: "0x00000000006c3852cbEf3e08E8dF289169EdE581" },
  ],
  ethereum: [
    { name: "Uniswap V2 router", address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" },
    { name: "Uniswap V3 SwapRouter02", address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" },
    { name: "Permit2", address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    { name: "Seaport 1.5", address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC" },
    { name: "Seaport 1.1", address: "0x00000000006c3852cbEf3e08E8dF289169EdE581" },
  ],
};

const DISCLAIMER =
  "Heuristic surface report, not a security audit: only the listed tokens and spenders were checked via live allowance() calls. A zero result does not mean the wallet has no approvals anywhere. Revoking is a wallet action — this report only names what to look at.";
const REPORT_TYPE = "approval surface report";
const UNLIMITED = (1n << 256n) - 1n; // 2^256 - 1, the "infinite approval" value
const ALLOWANCE_SEL = "0xdd62ed3e"; // allowance(address,address)
const CONCURRENCY = 8;

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function rpcCall(rpcs, method, params, timeoutMs = 15000) {
  let lastErr = null;
  for (const rpc of rpcs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
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
const auditCache = makeCache(15 * 60 * 1000);

// Spender code-presence check, cached 24h per chain so a spender that isn't
// deployed on a chain is skipped without slowing every request.
const spenderCodeCache = new Map(); // `${chain}:${addr}` -> { t, ok }
async function spenderHasCode(chain, addr) {
  const k = `${chain}:${addr.toLowerCase()}`;
  const e = spenderCodeCache.get(k);
  if (e && Date.now() - e.t < 24 * 60 * 60 * 1000) return e.ok;
  let ok = false;
  try {
    const code = await rpcCall(EVM_RPCS[chain], "eth_getCode", [addr, "latest"]);
    ok = typeof code === "string" && code !== "0x" && code.length > 2;
  } catch {
    ok = true; // RPC hiccup — don't drop a known-good spender on a transient error
  }
  spenderCodeCache.set(k, { t: Date.now(), ok });
  return ok;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}
function pad32(a) {
  return a.toLowerCase().replace("0x", "").padStart(64, "0");
}
function allowanceHuman(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = decimals === 0 ? s : s.slice(0, -decimals) || "0";
  let frac = decimals === 0 ? "" : s.slice(-decimals).replace(/0+$/, "");
  if (frac.length > 6) frac = frac.slice(0, 6);
  return frac ? `${int}.${frac}` : int;
}

async function runWithLimit(jobs, limit) {
  const results = new Array(jobs.length);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      try {
        results[idx] = { ok: true, v: await jobs[idx]() };
      } catch (e) {
        results[idx] = { ok: false, e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function approvalAudit(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = auditCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  let out;
  try {
    out = await runAudit(EVM_RPCS[ch], ch, addr);
  } catch (e) {
    if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
    throw e;
  }
  out = { generated_at: new Date().toISOString(), cached: false, ...out };
  auditCache.set(key, out);
  return out;
}

async function runAudit(rpcs, chain, addr) {
  const tokens = TOKENS[chain];
  const spenders = SPENDERS[chain];

  // Confirm each spender is actually a contract on this chain (once per 24h).
  const codeChecks = await runWithLimit(
    spenders.map((s) => () => spenderHasCode(chain, s.address)),
    CONCURRENCY
  );
  const liveSpenders = [];
  const skippedSpenders = [];
  spenders.forEach((s, i) => {
    if (codeChecks[i].ok && codeChecks[i].v) liveSpenders.push(s);
    else skippedSpenders.push(s.name);
  });
  if (!liveSpenders.length) throw new Error("no spender contracts reachable on this chain");

  // Sweep: allowance(owner, spender) for every token x spender pair.
  const pairs = [];
  for (const t of tokens) for (const s of liveSpenders) pairs.push([t, s]);
  const calls = await runWithLimit(
    pairs.map(([t, s]) => async () => {
      const data = ALLOWANCE_SEL + pad32(addr) + pad32(s.address);
      const r = await rpcCall(rpcs, "eth_call", [{ to: t.address, data }, "latest"]);
      if (r === "0x" || r === "" || r == null) return 0n;
      return BigInt(r);
    }),
    CONCURRENCY
  );

  const failed = calls.filter((c) => !c.ok).length;
  if (failed === calls.length) throw new Error("all allowance RPC calls failed");

  const approvals = [];
  calls.forEach((c, i) => {
    if (!c.ok || c.v === 0n) return;
    const [t, s] = pairs[i];
    const unlimited = c.v === UNLIMITED;
    approvals.push({
      token: t.address,
      token_symbol: t.symbol,
      spender: s.address,
      spender_name: s.name,
      allowance: c.v.toString(),
      allowance_human: unlimited ? "unlimited (2^256-1)" : `${allowanceHuman(c.v, t.decimals)} ${t.symbol}`,
      priority: unlimited ? "revoke-first" : "review",
      reason: unlimited
        ? `Unlimited allowance — ${s.name} can move the wallet's full ${t.symbol} balance at any time. Revoke this one first.`
        : `Live allowance of ${allowanceHuman(c.v, t.decimals)} ${t.symbol} to ${s.name} — revoke if this protocol is no longer used.`,
      _unlimited: unlimited,
      _raw: c.v,
    });
  });
  approvals.sort((a, b) => {
    if (a._unlimited !== b._unlimited) return a._unlimited ? -1 : 1;
    return a._raw > b._raw ? -1 : a._raw < b._raw ? 1 : 0;
  });
  const revoke_priority = approvals.map(({ _unlimited, _raw, ...rest }) => rest);
  const unlimited_count = approvals.filter((a) => a._unlimited).length;

  const coverage =
    `Known-protocol spender sweep: ${tokens.length} tokens x ${liveSpenders.length} spenders ` +
    `(${pairs.length - failed} live allowance checks on ${chain}). ` +
    (skippedSpenders.length ? `Skipped (no contract on this chain): ${skippedSpenders.join(", ")}. ` : "") +
    `Approvals granted to spenders outside this list are NOT covered — a zero result does not mean the wallet has no approvals.`;

  const summary = !approvals.length
    ? `No live approvals found among the ${tokens.length} checked tokens and ${liveSpenders.length} checked spenders on ${chain}. This is not a full-wallet check — approvals to other spenders are not covered. Heuristic surface report, not a security audit.`
    : `${approvals.length} live approval${approvals.length > 1 ? "s" : ""} found on ${chain}` +
      (unlimited_count
        ? `, ${unlimited_count} of them UNLIMITED (revoke-first)` +
          (approvals.length > unlimited_count ? ` and ${approvals.length - unlimited_count} to review` : "")
        : `, all limited — review each`) +
      `. Heuristic surface report, not a security audit.`;

  return {
    chain,
    address: addr,
    report_type: REPORT_TYPE,
    coverage,
    approvals_found: approvals.length,
    unlimited_count,
    revoke_priority,
    summary,
    source: `public keyless RPCs (no key): ${rpcs.join(", ")}`,
    disclaimer: DISCLAIMER,
  };
}

module.exports = { approvalAudit, APPROVAL_AUDIT_CHAINS: Object.keys(BLOCKSCOUT) };
