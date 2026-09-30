// TrollBridge verdict family — data layer (the $0 edition).
// Four derived-verdict lanes for the moment before money moves:
//   /honeypot      — honeypot screen: simulated sells via eth_call, tax/transfer
//                    flags, blacklist/pausable heuristics. Verdict: safe / suspicious / honeypot.
//   /approval-risk — wallet approval audit: recent approve() calls decoded,
//                    live allowance checks, unlimited approvals and risky
//                    spenders flagged, revoke priority list. Verdict: clean / review / urgent.
//   /rug-score     — rug-pull risk 0-100: LP burn status, holder concentration,
//                    mint authority, ownership, sell pressure. One-line verdict.
//   /receipt-check — "did it land?" settlement verification: tx status,
//                    confirmations, value moved, token transfers decoded.
//                    Verdict: settled / pending / failed / not-found.
//   /preflight     — the full insurance inspection in one call: honeypot
//                    screen + rug-pull score + contract safety screen, plus
//                    the wallet approval audit when a wallet= is given.
//                    One overall verdict: cleared for takeoff / proceed with
//                    caution / do not touch.
//
// HEURISTIC VERDICTS, NOT AUDITS: every response carries that wording. These
// are pattern matches against public on-chain data, not security reviews —
// a clean verdict does not mean an asset is safe.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const BLOCKSCOUT = {
  base: "https://base.blockscout.com/api/v2",
  ethereum: "https://eth.blockscout.com/api/v2",
};
const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};
const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana.public-rpc.com"];
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";
const DISCLAIMER =
  "Heuristic verdict from public on-chain data — not financial advice and not a security audit. Verify independently before moving funds.";

const TRANSFER_SEL = "0xa9059cbb"; // transfer(address,uint256)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVE_SEL = "0x095ea7b3"; // approve(address,uint256)
const ALLOWANCE_SEL = "0xdd62ed3e"; // allowance(address,address)
const OWNER_SEL = "0x8da5cb5b"; // owner()
const BALANCEOF_SEL = "0x70a08231"; // balanceOf(address)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const UNLIMITED_ALLOWANCE = 1n << 255n;

async function getJSON(url, timeoutMs = 45000) {
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
// Short-timeout variant for endpoints known to hang on big tokens
// (Blockscout /holders) — fail fast, the lane degrades gracefully.
function getJSONFast(url) {
  return getJSON(url, 12000);
}

// Raw JSON-RPC that distinguishes an on-chain revert from a dead RPC:
// { transportOk, reverted, result?, error? }. A revert is DATA (the call
// would fail on-chain); a transport failure means try the next RPC.
async function rpcRaw(rpcs, method, params, timeoutMs = 30000) {
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
      if (!res.ok) continue;
      const j = await res.json();
      if (j.error) {
        const msg = (j.error && (j.error.message || j.error.code)) || "";
        return { transportOk: true, reverted: true, error: String(msg).slice(0, 200) };
      }
      return { transportOk: true, reverted: false, result: j.result };
    } catch {
      /* try next RPC */
    }
  }
  return { transportOk: false, reverted: false };
}

async function rpcCall(rpcs, method, params, timeoutMs = 15000) {
  const r = await rpcRaw(rpcs, method, params, timeoutMs);
  if (!r.transportOk) throw new Error("all RPCs failed");
  if (r.reverted) throw new Error(`call reverted: ${r.error || "unknown"}`);
  return r.result;
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
const honeypotCache = makeCache(15 * 60 * 1000);
const approvalCache = makeCache(10 * 60 * 1000);
const rugCache = makeCache(15 * 60 * 1000);
const receiptCache = makeCache(5 * 60 * 1000);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}
function isTxHash(h) {
  return /^0x[0-9a-fA-F]{64}$/.test(h || "");
}
function isSolSignature(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s || "");
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function padAddr(a) {
  return a.toLowerCase().replace("0x", "").padStart(64, "0");
}
function padUint(bn) {
  return bn.toString(16).padStart(64, "0");
}
function topicToAddr(topic) {
  if (!topic || topic.length < 66) return null;
  return "0x" + topic.slice(-40);
}
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function withCache(cache, key, run) {
  return (async () => {
    const hit = cache.get(key);
    if (hit && hit.fresh) return { ...hit.fresh, cached: true };
    let out;
    try {
      out = await run();
    } catch (e) {
      if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
      throw e;
    }
    out = { generated_at: new Date().toISOString(), cached: false, ...out };
    cache.set(key, out);
    return out;
  })();
}

// ====================================================================
// /honeypot — honeypot screen
// ====================================================================
function scanTokenSource(src) {
  const flags = [];
  const code = stripComments(src);
  if (/\bblacklist\b/i.test(code) || /_isBlacklisted|isBlacklisted\s*\(/i.test(code)) {
    flags.push({
      severity: "high",
      code: "blacklist",
      title: "Blacklist mechanism present",
      detail: "The code contains blacklist logic — the owner can block specific wallets from transferring, the classic honeypot freeze.",
    });
  }
  if (/function\s+pause\s*\(/i.test(code) || /\bPausable\b/.test(code)) {
    flags.push({
      severity: "medium",
      code: "pausable",
      title: "Transfers can be paused",
      detail: "The contract can pause transfers. A paused token cannot be sold until the owner unpauses it.",
    });
  }
  if (/function\s+set\w*(tax|fee)\w*\s*\(/i.test(code) || /\b(buyTax|sellTax|_buyTax|_sellTax|taxFee|_taxFee)\b/.test(code)) {
    flags.push({
      severity: "medium",
      code: "adjustable-tax",
      title: "Transfer taxes are adjustable",
      detail: "Buy/sell tax variables with setter functions exist — the owner can raise the sell tax to 100%, which is a soft honeypot.",
    });
  }
  if (/\b_maxTxAmount\b|\bmaxTxAmount\b/.test(code) && /function\s+set\w*max\w*tx/i.test(code)) {
    flags.push({
      severity: "low",
      code: "adjustable-max-tx",
      title: "Max transaction amount is adjustable",
      detail: "The owner can change the max transaction size — it can be set to ~0 to block sells.",
    });
  }
  if (/\b_maxWallet\b|\bmaxWalletAmount\b/.test(code) && /function\s+set\w*max\w*wallet/i.test(code)) {
    flags.push({
      severity: "low",
      code: "adjustable-max-wallet",
      title: "Max wallet amount is adjustable",
      detail: "The owner can change the max wallet size — a way to selectively block holders.",
    });
  }
  return flags;
}

async function honeypotScreen(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const api = BLOCKSCOUT[ch];
  const key = `honeypot:${ch}:${addr.toLowerCase()}`;
  return withCache(honeypotCache, key, () => runHoneypot(api, ch, addr));
}

async function runHoneypot(api, chain, addr) {
  const info = await getJSON(`${api}/addresses/${addr}`);
  if (!info) throw badRequest("address not found on this chain — check the address and chain");
  if (!info.is_contract) throw badRequest("address is not a contract (no bytecode) — nothing to screen");

  const findings = [];
  const verified = info.is_verified === true;
  if (info.is_scam === true) {
    findings.push({ severity: "critical", code: "blockscout-scam-flag", title: "Blockscout flags this address as a scam", detail: "Blockscout's own reputation feed marks this contract as a scam. Do not interact." });
  }
  if (!verified) {
    findings.push({ severity: "high", code: "unverified", title: "Contract source is NOT verified", detail: "No published source — transfer restrictions cannot be read. Unverified contracts are the most common honeypot shape." });
  } else {
    try {
      const sc = await getJSON(`${api}/smart-contracts/${addr}`);
      const src = sc && sc.source_code;
      if (src) findings.push(...scanTokenSource(src));
    } catch { /* source scan is a bonus */ }
  }

  // Sell simulation: eth_call a tiny transfer FROM funded holder wallets. We
  // sample recent transfer senders, then REQUIRE each one to (a) actually hold
  // a balance (balanceOf > 0) and (b) be an EOA, not a contract — a zero-balance
  // sender or a contract reverts benignly and would be a false alarm. Only
  // funded-holder reverts count. ≥2 funded-holder reverts = suspicious
  // (selective blocking); every funded holder reverting = honeypot. Fewer than
  // 2 funded holders = sample too small, no simulation-based finding.
  // (Blockscout's /holders endpoint hangs on large-holder tokens, so recent
  // transfers are the reliable holder source.)
  const sim = { holders_tested: 0, succeeded: 0, reverted: 0, skipped: 0, transport_failed: false, note: null };
  try {
    const transfers = await getJSON(`${api}/tokens/${addr}/transfers`);
    const candidates = [];
    for (const t of (transfers && transfers.items) || []) {
      const f = t.from && t.from.hash;
      const fl = (f || "").toLowerCase();
      if (f && !DEAD_ADDRESSES.has(fl) && fl !== addr.toLowerCase() && !candidates.some((c) => c.toLowerCase() === fl)) {
        candidates.push(f);
      }
      if (candidates.length >= 8) break;
    }
    const transferTo = "0x000000000000000000000000000000000000dEaD";
    // Transport resilience: an isolated RPC hiccup skips that sender and we
    // keep screening; 2 consecutive transport failures means the RPCs are
    // down, so abort fast instead of burning minutes on dead calls.
    let transportStrikes = 0;
    const strike = () => {
      transportStrikes++;
      sim.skipped++;
      if (transportStrikes >= 2) { sim.transport_failed = true; return true; }
      return false;
    };
    for (const sender of candidates) {
      if (sim.holders_tested >= 3 || sim.transport_failed) break;
      await sleep(350); // stay under public-RPC rate limits (429s kill the sim)
      // (a) must hold a balance — zero-balance senders revert benignly
      const balCall = await rpcRaw(EVM_RPCS[chain], "eth_call", [{ to: addr, data: BALANCEOF_SEL + padAddr(sender) }, "latest"], 15000);
      if (!balCall.transportOk) { if (strike()) break; else continue; }
      transportStrikes = 0;
      let bal = 0n;
      try { bal = BigInt(balCall.result || "0x0"); } catch { bal = 0n; }
      if (balCall.reverted || bal === 0n) { sim.skipped++; continue; }
      await sleep(350);
      // (b) must be an EOA — contracts can revert for unrelated reasons
      const codeCall = await rpcRaw(EVM_RPCS[chain], "eth_getCode", [sender, "latest"], 15000);
      if (!codeCall.transportOk) { if (strike()) break; else continue; }
      transportStrikes = 0;
      const code = codeCall.result || "0x";
      if (!codeCall.reverted && code !== "0x" && code !== "0x0") { sim.skipped++; continue; }
      await sleep(350);
      // funded EOA holder — simulate a tiny sell (their balance or 1000 units)
      const amount = bal < 1000n ? bal : 1000n;
      const data = TRANSFER_SEL + padAddr(transferTo) + padUint(amount);
      const r = await rpcRaw(EVM_RPCS[chain], "eth_call", [{ from: sender, to: addr, data }, "latest"], 15000);
      if (!r.transportOk) { if (strike()) break; else continue; }
      transportStrikes = 0;
      sim.holders_tested++;
      if (r.reverted) sim.reverted++;
      else sim.succeeded++;
    }
    if (!sim.transport_failed && sim.holders_tested < 2) {
      sim.note = sim.holders_tested === 0
        ? "no funded holder wallets available to simulate from — verdict rests on code patterns only"
        : "only one funded holder available to simulate from — sample too small, verdict rests on code patterns only";
    }
    if (sim.transport_failed) sim.note = "holder/simulation lookup hit upstream timeouts — verdict rests on code patterns only";
  } catch {
    sim.transport_failed = true;
    sim.note = "holder/simulation lookup hit an upstream timeout — verdict rests on code patterns only";
  }
  if (!sim.transport_failed && sim.holders_tested >= 2) {
    if (sim.reverted >= 2 && sim.reverted === sim.holders_tested) {
      findings.push({ severity: "critical", code: "sell-simulation-reverted", title: `Simulated sells revert for all ${sim.holders_tested} funded holders tested`, detail: "A tiny transfer simulated from real funded holder wallets reverts on-chain — holders cannot move their tokens. This is the textbook honeypot signature." });
    } else if (sim.reverted >= 2) {
      findings.push({ severity: "high", code: "sell-simulation-partial", title: `Simulated sells revert for ${sim.reverted}/${sim.holders_tested} funded holders tested`, detail: "Some funded holders' transfers revert while others succeed — selective transfer blocking, consistent with a blacklist-style honeypot." });
    }
  }

  const SEV = { critical: 50, high: 25, medium: 12, low: 5, info: 0 };
  const score = Math.min(100, findings.reduce((s, f) => s + (SEV[f.severity] || 0), 0));
  const verdict = score >= 50 ? "honeypot" : score >= 20 ? "suspicious" : "safe";
  const worst = findings.find((f) => f.severity === "critical") || findings[0];
  const simOk = !sim.transport_failed && sim.holders_tested >= 2;
  const summary =
    verdict === "safe"
      ? (simOk
        ? `Simulated sells succeed from ${sim.holders_tested} funded holder wallets and no transfer-blocking patterns found. Heuristic screen, not an audit — read the code before real money.`
        : "No transfer-blocking patterns found in the code; sell simulation was unavailable or had too few funded holders, so this rests on static patterns only. Heuristic screen, not an audit.")
      : `${verdict.toUpperCase()} (${score}/100): ${worst ? worst.title.toLowerCase() : "flagged patterns"}. Heuristic screen, not an audit.`;

  return {
    chain,
    address: addr,
    token: info.token ? { name: info.token.name, symbol: info.token.symbol, decimals: num(info.token.decimals) } : null,
    verified,
    verdict,
    risk_score: score,
    sell_simulation: sim,
    findings,
    summary,
    source: "blockscout keyless api + public rpc eth_call (no key)",
    disclaimer: DISCLAIMER,
    note: "Heuristic screen, not an audit. Refresh: 15-min cache.",
  };
}

// ====================================================================
// /approval-risk — wallet approval audit
// ====================================================================
async function approvalRisk(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const api = BLOCKSCOUT[ch];
  const key = `approval:${ch}:${addr.toLowerCase()}`;
  return withCache(approvalCache, key, () => runApproval(api, ch, addr));
}

async function runApproval(api, chain, addr) {
  // Pull the wallet's recent transactions and decode approve() calls.
  const txPage = await getJSON(`${api}/addresses/${addr}/transactions`);
  const items = (txPage && txPage.items) || [];
  const seen = new Map(); // token+spender -> { token, spender, tx_hash }
  for (const t of items) {
    const input = t.raw_input || t.input || "";
    if (!input.startsWith(APPROVE_SEL) || input.length < 138) continue;
    const token = t.to && t.to.hash ? t.to.hash : null;
    if (!token) continue;
    const spender = "0x" + input.slice(34, 74);
    if (!isAddress(spender)) continue;
    const k = `${token.toLowerCase()}:${spender.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, { token, spender, tx_hash: t.hash });
    if (seen.size >= 25) break;
  }

  const approvals = [];
  const spenderInfoCache = new Map();
  async function spenderInfo(spender) {
    const k = spender.toLowerCase();
    if (spenderInfoCache.has(k)) return spenderInfoCache.get(k);
    const out = { is_contract: false, verified: null, is_scam: false, name: null };
    try {
      const code = await rpcCall(EVM_RPCS[chain], "eth_getCode", [spender, "latest"]);
      out.is_contract = !!(code && code !== "0x" && code !== "0x0");
    } catch { /* treat as unknown */ }
    if (out.is_contract) {
      try {
        const si = await getJSON(`${api}/addresses/${spender}`);
        if (si) {
          out.verified = si.is_verified === true;
          out.is_scam = si.is_scam === true;
          out.name = si.name || null;
        }
      } catch { /* best effort */ }
    }
    spenderInfoCache.set(k, out);
    return out;
  }

  for (const { token, spender, tx_hash } of seen.values()) {
    let allowance = null;
    let allowanceReadable = true;
    try {
      const data = ALLOWANCE_SEL + padAddr(addr) + padAddr(spender);
      const res = await rpcCall(EVM_RPCS[chain], "eth_call", [{ to: token, data }, "latest"]);
      allowance = BigInt(res || "0x0");
    } catch {
      allowanceReadable = false;
    }
    const unlimited = allowance !== null && allowance >= UNLIMITED_ALLOWANCE;
    const si = await spenderInfo(spender);
    const riskySpender = si.is_scam || (!si.is_contract) || (si.is_contract && si.verified === false);
    let priority = "info";
    let reason = "limited allowance";
    if (unlimited && (si.is_scam || !si.is_contract || si.verified === false)) {
      priority = "urgent";
      reason = si.is_scam
        ? "unlimited allowance to a Blockscout-flagged scam contract"
        : !si.is_contract
          ? "unlimited allowance to an externally-owned account (not a contract)"
          : "unlimited allowance to an unverified contract";
    } else if (unlimited) {
      priority = "review";
      reason = "unlimited allowance to a verified contract — fine until the contract is upgraded or exploited";
    } else if (allowanceReadable && riskySpender && allowance > 0n) {
      priority = "review";
      reason = "allowance granted to an unverified contract or EOA";
    }
    let tokenSymbol = null;
    try {
      const ti = await getJSON(`${api}/tokens/${token}`);
      if (ti) tokenSymbol = ti.symbol || null;
    } catch { /* best effort */ }
    approvals.push({
      token,
      token_symbol: tokenSymbol,
      spender,
      spender_name: si.name,
      spender_is_contract: si.is_contract,
      spender_verified: si.verified,
      allowance: allowance !== null ? allowance.toString() : null,
      allowance_readable: allowanceReadable,
      unlimited,
      priority,
      reason,
      approve_tx: tx_hash,
    });
  }

  const byPri = { urgent: 0, review: 0, info: 0 };
  for (const a of approvals) byPri[a.priority] = (byPri[a.priority] || 0) + 1;
  const revokeFirst = approvals
    .filter((a) => a.priority === "urgent" || a.priority === "review")
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "urgent" ? -1 : 1));
  const verdict = byPri.urgent > 0 ? "urgent" : byPri.review > 0 ? "review" : "clean";
  const summary =
    verdict === "clean"
      ? (approvals.length
        ? `Clean: ${approvals.length} approval(s) found, none unlimited to risky spenders.`
        : "Clean: no approve() calls found in recent transaction history.")
      : `${verdict.toUpperCase()}: ${byPri.urgent} urgent, ${byPri.review} need review, ${byPri.info} informational — revoke the urgent ones first (revoke.cash or the token contract's approve(spender, 0)).`;

  return {
    chain,
    address: addr,
    transactions_scanned: items.length,
    approvals_found: approvals.length,
    unlimited_count: approvals.filter((a) => a.unlimited).length,
    verdict,
    revoke_priority: revokeFirst.map((a) => ({
      token: a.token,
      token_symbol: a.token_symbol,
      spender: a.spender,
      priority: a.priority,
      reason: a.reason,
    })),
    approvals,
    summary,
    source: "blockscout keyless api + public rpc eth_call (no key)",
    disclaimer: DISCLAIMER,
    note: "Scans recent on-chain approve() calls (last page of history) with live allowance checks. Refresh: 10-min cache.",
  };
}

// ====================================================================
// /rug-score — rug-pull risk 0-100
// ====================================================================
async function rugScore(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const api = BLOCKSCOUT[ch];
  const key = `rug:${ch}:${addr.toLowerCase()}`;
  return withCache(rugCache, key, () => runRug(api, ch, addr));
}

async function runRug(api, chain, addr) {
  const findings = [];
  let score = 0;
  const add = (pts, severity, code, title, detail) => {
    score += pts;
    findings.push({ severity, code, title, detail });
  };

  // DexScreener: pairs, liquidity, buy/sell flow.
  let pairs = [];
  try {
    const dex = await getJSON(`${DEX_TOKENS}${addr}`);
    pairs = ((dex && dex.pairs) || []).filter((p) => (p.chainId || "").toLowerCase() === chain);
  } catch { /* dexscreener is a bonus */ }
  pairs.sort((a, b) => (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0));
  const top = pairs[0] || null;
  if (!top) {
    add(30, "high", "no-liquidity-pairs", "No DEX liquidity pairs found", "DexScreener tracks no liquid pairs for this token on this chain — there may be nowhere to sell at all.");
  }
  const liquidityUsd = top ? num(top.liquidity && top.liquidity.usd) : null;
  if (top && liquidityUsd !== null && liquidityUsd < 10000) {
    add(15, "medium", "thin-liquidity", `Thin liquidity ($${Math.round(liquidityUsd).toLocaleString()})`, "Very thin liquidity — even small sells move the price hard, and liquidity can be pulled cheaply.");
  }

  // LP burn check: does a dead address hold ~all of the LP tokens?
  // Only meaningful for fungible-LP pools (Uniswap V2 style). Concentrated-
  // liquidity pools (Aerodrome, Uniswap V3, …) use NFT positions — there is
  // no LP token to burn-check, so we detect that on-chain (totalSupply call)
  // and mark the check N/A instead of scoring a false positive.
  let lp = null;
  const TOTALSUPPLY_SEL = "0x18160ddd"; // totalSupply()
  if (top && top.pairAddress && isAddress(top.pairAddress)) {
    try {
      const tsCall = await rpcRaw(EVM_RPCS[chain], "eth_call", [{ to: top.pairAddress, data: TOTALSUPPLY_SEL }, "latest"]);
      const isFungibleLp = tsCall.transportOk && !tsCall.reverted;
      if (!isFungibleLp) {
        lp = { pair: top.pairAddress, dex: top.dexId || null, lp_burned_pct: null, note: "concentrated-liquidity pool — no fungible LP token to burn-check (NFT positions)" };
      } else {
        const lpHolders = await getJSONFast(`${api}/tokens/${top.pairAddress}/holders`);
      const items = (lpHolders && lpHolders.items) || [];
      let deadSum = 0, total = 0;
      for (const h of items) {
        const v = num(h.value) || 0;
        total += v;
        if (h.address_hash && DEAD_ADDRESSES.has(h.address_hash.toLowerCase())) deadSum += v;
      }
      const deadPct = total > 0 ? (deadSum / total) * 100 : null;
      lp = { pair: top.pairAddress, dex: top.dexId || null, lp_burned_pct: deadPct === null ? null : +deadPct.toFixed(2) };
      const deepPool = (top.liquidity && top.liquidity.usd >= 1000000);
      if (deadPct === null) {
        lp.note = "LP holder data unavailable";
      } else if (deadPct >= 95) {
        lp.note = "LP tokens look burned — team cannot pull the liquidity";
      } else if (deepPool) {
        lp.note = `Deep pool ($${Math.round(top.liquidity.usd).toLocaleString()} liquidity) — LP held by market makers, burn check not meaningful for established pairs`;
      } else if (deadPct >= 50) {
        add(20, "medium", "lp-partial-burn", `Only ${deadPct.toFixed(1)}% of LP burned`, "Part of the LP supply is still held by live wallets — that liquidity can still be pulled.");
      } else {
        add(35, "high", "lp-not-burned", `Only ${deadPct.toFixed(1)}% of LP burned`, "The team (or someone) still holds most LP tokens — they can drain the pool and rug in one transaction.");
      }
      }
    } catch {
      lp = { pair: top.pairAddress, note: "LP holder lookup failed" };
    }
  }

  // Token holder concentration.
  let concentration = null;
  try {
    const holders = await getJSONFast(`${api}/tokens/${addr}/holders`);
    const items = (holders && holders.items) || [];
    const info = await getJSON(`${api}/tokens/${addr}`);
    const totalRaw = info ? num(info.total_supply) : null;
    if (items.length && totalRaw) {
      const topSum = items.slice(0, 10).reduce((s, h) => s + (num(h.value) || 0), 0);
      const share = (topSum / totalRaw) * 100;
      concentration = { holders_tracked: items.length, top_10_share_pct: +share.toFixed(2) };
      if (share >= 90) add(25, "high", "holder-concentration", `Top 10 hold ${share.toFixed(1)}% of supply`, "Near-total insider concentration — a coordinated dump craters the price.");
      else if (share >= 70) add(15, "medium", "holder-concentration", `Top 10 hold ${share.toFixed(1)}% of supply`, "Heavy insider concentration — large exits move the price hard.");
    }
  } catch { /* bonus */ }

  // Ownership: renounced?
  let ownership = null;
  try {
    const r = await rpcRaw(EVM_RPCS[chain], "eth_call", [{ to: addr, data: OWNER_SEL }, "latest"]);
    if (r.transportOk && !r.reverted && r.result && r.result.length >= 66) {
      const owner = "0x" + r.result.slice(-40);
      const renounced = /^0x0+$/.test(owner);
      ownership = { owner, renounced };
      if (!renounced) add(8, "low", "ownership-retained", "Ownership not renounced", `owner() returns ${owner} — admin powers still exist. Matters most if mint/tax functions exist.`);
    } else if (r.transportOk && !r.reverted) {
      ownership = { note: "no owner() function" };
    }
  } catch { /* bonus */ }

  // Mint authority + verification via Blockscout.
  let verified = null;
  try {
    const info = await getJSON(`${api}/addresses/${addr}`);
    verified = info ? info.is_verified === true : null;
    if (verified === false) add(15, "medium", "unverified", "Contract source is NOT verified", "Cannot read mint/tax logic — unverified contracts are the most common rug shape.");
    if (info && info.is_scam === true) add(50, "critical", "blockscout-scam-flag", "Blockscout flags this address as a scam", "Blockscout's reputation feed marks this contract as a scam. Do not interact.");
    if (verified) {
      const sc = await getJSON(`${api}/smart-contracts/${addr}`);
      const src = sc && sc.source_code ? stripComments(sc.source_code) : "";
      if (src && /function\s+[A-Za-z0-9_]*[Mm][Ii][Nn][Tt][A-Za-z0-9_]*\s*\(/.test(src)) {
        if (ownership && ownership.renounced === false) add(20, "high", "mint-live", "Mint function with live ownership", "The contract can mint new tokens and ownership is not renounced — supply can be inflated and holders diluted.");
        else if (ownership && ownership.renounced) add(5, "low", "mint-renounced", "Mint function but ownership renounced", "Mint exists but owner() is the zero address — mint is likely bricked, but verify the renounce is real.");
        else add(12, "medium", "mint-present", "Mint function present", "The contract contains mint logic — check who can call it before trusting the supply cap.");
      }
    }
  } catch { /* bonus */ }

  // Sell pressure from DexScreener flow.
  if (top && top.txns && top.txns.h24) {
    const buys = num(top.txns.h24.buys) || 0;
    const sells = num(top.txns.h24.sells) || 0;
    if (sells > buys * 3 && sells > 10) {
      add(10, "medium", "sell-pressure", `Heavy sell pressure (${sells} sells vs ${buys} buys / 24h)`, "Sellers outnumber buyers 3:1 — possible slow rug / insider exit in progress.");
    }
  }

  score = Math.min(100, score);
  const verdict =
    score >= 60 ? "likely rug — do not touch" :
    score >= 35 ? "high risk" :
    score >= 15 ? "caution" : "looks okay";
  const worst = findings.find((f) => f.severity === "critical") || findings.find((f) => f.severity === "high") || findings[0];
  const summary =
    verdict === "looks okay"
      ? `Low heuristic risk (${score}/100): LP ${lp && lp.lp_burned_pct !== null && lp.lp_burned_pct !== undefined ? lp.lp_burned_pct + "% burned" : "status unknown"}. Still not an audit — read the code before real money.`
      : `${verdict.toUpperCase()} (${score}/100): ${worst ? worst.title.toLowerCase() : "flagged patterns"}. Heuristic score, not an audit.`;

  return {
    chain,
    address: addr,
    token: top && top.baseToken ? { name: top.baseToken.name, symbol: top.baseToken.symbol } : null,
    verdict,
    risk_score: score,
    liquidity_usd: liquidityUsd,
    lp,
    holder_concentration: concentration,
    ownership,
    verified,
    pairs_tracked: pairs.length,
    findings,
    summary,
    source: "dexscreener free api + blockscout keyless api + public rpc (no key)",
    disclaimer: DISCLAIMER,
    note: "Heuristic score, not an audit. Refresh: 15-min cache.",
  };
}

// ====================================================================
// /receipt-check — "did it land?" settlement verification
// ====================================================================
async function receiptCheck(tx, chain) {
  const t = (tx || "").trim();
  const ch = (chain || "base").toLowerCase();
  if (!["base", "ethereum", "solana"].includes(ch)) throw badRequest("chain must be base, ethereum, or solana");
  if (ch === "solana") {
    if (!isSolSignature(t)) throw badRequest("tx must be a base58 Solana transaction signature");
  } else if (!isTxHash(t)) {
    throw badRequest("tx must be a 0x… transaction hash (64 hex chars)");
  }
  const key = `receipt:${ch}:${t.toLowerCase()}`;
  return withCache(receiptCache, key, () =>
    ch === "solana" ? runReceiptSolana(t) : runReceiptEvm(BLOCKSCOUT[ch], EVM_RPCS[ch], ch, t)
  );
}

async function tokenMeta(api, tokenAddr, cache) {
  const k = tokenAddr.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const out = { symbol: null, decimals: null };
  try {
    const ti = await getJSON(`${api}/tokens/${tokenAddr}`);
    if (ti) {
      out.symbol = ti.symbol || null;
      out.decimals = num(ti.decimals);
    }
  } catch { /* best effort */ }
  cache.set(k, out);
  return out;
}

function formatTokenAmount(raw, decimals) {
  try {
    const bn = BigInt(raw);
    if (decimals === null || decimals === undefined) return bn.toString() + " (raw)";
    const d = BigInt(decimals);
    const base = 10n ** d;
    const whole = bn / base;
    const frac = (bn % base).toString().padStart(Number(d), "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return String(raw);
  }
}

async function runReceiptEvm(api, rpcs, chain, txHash) {
  const receipt = await rpcCall(rpcs, "eth_getTransactionReceipt", [txHash]).catch((e) => {
    throw new Error(`receipt lookup failed: ${e.message}`);
  });
  if (!receipt) {
    // No receipt yet: is the tx even known?
    const tx = await rpcCall(rpcs, "eth_getTransactionByHash", [txHash]).catch(() => null);
    if (!tx) {
      return { chain, tx: txHash, verdict: "not-found", summary: "Transaction not found on this chain — check the hash and chain.", confirmations: 0 };
    }
    return { chain, tx: txHash, verdict: "pending", summary: "Transaction is known but has no receipt yet — still in the mempool or just mined.", confirmations: 0, from: tx.from, to: tx.to };
  }

  const status = receipt.status === "0x1" ? "settled" : "failed";
  const blockNum = num(receipt.blockNumber);
  let confirmations = null;
  try {
    const latest = await rpcCall(rpcs, "eth_blockNumber", []);
    const latestNum = num(latest);
    if (latestNum !== null && blockNum !== null) confirmations = Math.max(0, latestNum - blockNum);
  } catch { /* bonus */ }

  let tx = null;
  try {
    tx = await rpcCall(rpcs, "eth_getTransactionByHash", [txHash]);
  } catch { /* bonus */ }

  // Decode ERC20 Transfer events from the logs.
  const metaCache = new Map();
  const token_transfers = [];
  for (const log of receipt.logs || []) {
    const topics = log.topics || [];
    if (!topics[0] || topics[0].toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    const from = topicToAddr(topics[1]);
    const to = topicToAddr(topics[2]);
    let raw = "0";
    try {
      raw = BigInt(log.data || "0x0").toString();
    } catch { /* keep 0 */ }
    const meta = await tokenMeta(api, log.address, metaCache);
    token_transfers.push({
      token: log.address,
      symbol: meta.symbol,
      from,
      to,
      amount: formatTokenAmount(raw, meta.decimals),
      amount_raw: raw,
    });
  }

  const valueEth = tx && tx.value ? formatTokenAmount(BigInt(tx.value).toString(), 18) : null;
  return {
    chain,
    tx: txHash,
    verdict: status,
    block_number: blockNum,
    confirmations,
    from: tx ? tx.from : null,
    to: tx ? tx.to : null,
    value_eth: valueEth,
    gas_used: receipt.gasUsed ? num(receipt.gasUsed) : null,
    effective_gas_price_wei: receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice).toString() : null,
    token_transfers,
    summary:
      status === "settled"
        ? `Settled in block ${blockNum}${confirmations !== null ? ` (${confirmations} confirmations)` : ""}${token_transfers.length ? ` — ${token_transfers.length} token transfer(s) decoded` : valueEth ? ` — ${valueEth} ETH moved` : ""}.`
        : `FAILED on-chain (status 0) in block ${blockNum} — the transaction executed but reverted.`,
    source: "public rpc + blockscout keyless api (no key)",
    disclaimer: DISCLAIMER,
    note: "Refresh: 5-min cache.",
  };
}

async function runReceiptSolana(sig) {
  const r = await rpcRaw(SOLANA_RPCS, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!r.transportOk) throw new Error("all Solana RPCs failed");
  const j = r.result;
  if (!j) {
    return { chain: "solana", tx: sig, verdict: "not-found", summary: "Transaction not found on Solana — check the signature.", confirmations: 0 };
  }
  const meta = j.meta || {};
  const status = meta.err ? "failed" : "settled";
  const slot = num(j.slot);
  let confirmations = null;
  try {
    const cur = await rpcCall(SOLANA_RPCS, "getSlot", []);
    const curNum = num(cur);
    if (curNum !== null && slot !== null) confirmations = Math.max(0, curNum - slot);
  } catch { /* bonus */ }
  const confStatus = j.confirmationStatus || null;
  return {
    chain: "solana",
    tx: sig,
    verdict: status,
    slot,
    confirmations,
    confirmation_status: confStatus,
    fee_lamports: meta.fee !== undefined ? meta.fee : null,
    log_messages: (meta.logMessages || []).slice(0, 10),
    summary:
      status === "settled"
        ? `Settled in slot ${slot}${confirmations !== null ? ` (~${confirmations} slots ago)` : ""}${confStatus ? ` — ${confStatus}` : ""}.`
        : `FAILED on-chain in slot ${slot} — program error: ${JSON.stringify(meta.err).slice(0, 160)}.`,
    source: "public solana rpc (no key)",
    disclaimer: DISCLAIMER,
    note: "Refresh: 5-min cache.",
  };
}

// ====================================================================
// /preflight — the full insurance inspection in one call
// ====================================================================
// Runs the honeypot screen, the rug-pull score, and the contract safety
// screen against the token contract in parallel, plus the wallet approval
// audit when a wallet= address is supplied. Rolls everything up into one
// overall verdict: cleared for takeoff / proceed with caution / do not touch.
const { checkContract } = require("./contract-check");
const preflightCache = makeCache(5 * 60 * 1000);

function preflightDanger(checkName, out) {
  if (checkName === "honeypot")
    return out.verdict === "honeypot" ? 3 : out.verdict === "suspicious" ? 2 : 0;
  if (checkName === "rug-score")
    return String(out.verdict).startsWith("likely rug") ? 3
      : out.verdict === "high risk" ? 2
      : out.verdict === "caution" ? 1 : 0;
  if (checkName === "contract-check")
    return out.risk === "critical" ? 3 : out.risk === "high" ? 2 : out.risk === "medium" ? 1 : 0;
  if (checkName === "approval-risk")
    // Owner's call: wallet risk vetoes alone — an "urgent" wallet (unlimited
    // approvals to risky spenders) triggers "do not touch" on its own.
    return out.verdict === "urgent" ? 3 : out.verdict === "review" ? 1 : 0;
  return 0;
}

function worstFindingOf(checkName, out) {
  const findings = out.findings || [];
  // approval-risk reports revoke_priority instead of findings — treat the top
  // revoke item as the finding.
  const pool = findings.length
    ? findings
    : (out.revoke_priority || []).map((r) => ({
        severity: r.priority === "urgent" ? "high" : "medium",
        code: "risky-approval",
        title: `${r.token_symbol || "token"} approval to ${String(r.spender).slice(0, 10)}…`,
        detail: r.reason,
      }));
  const worst = pool.find((f) => f.severity === "critical")
    || pool.find((f) => f.severity === "high")
    || pool[0] || null;
  if (!worst) return null;
  return { check: checkName, severity: worst.severity, code: worst.code, title: worst.title, detail: worst.detail };
}

function slimCheck(checkName, out) {
  if (checkName === "honeypot") return { verdict: out.verdict, risk_score: out.risk_score, summary: out.summary };
  if (checkName === "rug-score") return { verdict: out.verdict, risk_score: out.risk_score, summary: out.summary };
  if (checkName === "contract-check") return { risk: out.risk, risk_score: out.risk_score, summary: out.summary };
  if (checkName === "approval-risk") return { verdict: out.verdict, approvals_found: out.approvals_found, unlimited_count: out.unlimited_count, summary: out.summary };
  return { summary: out.summary };
}

async function preflight(address, chain, wallet) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const w = (wallet || "").trim();
  if (w && !isAddress(w)) throw badRequest("wallet must be a 0x… Ethereum-style address (40 hex chars)");
  const key = `preflight:${ch}:${addr.toLowerCase()}:${w ? w.toLowerCase() : "-"}`;
  return withCache(preflightCache, key, () => runPreflight(addr, ch, w || null));
}

async function runPreflight(addr, ch, wallet) {
  const jobs = {
    honeypot: honeypotScreen(addr, ch),
    "rug-score": rugScore(addr, ch),
    "contract-check": checkContract(addr, ch),
  };
  if (wallet) jobs["approval-risk"] = approvalRisk(wallet, ch);
  const names = Object.keys(jobs);
  const results = await Promise.all(names.map((n) =>
    jobs[n].then(
      (out) => ({ name: n, ok: true, out }),
      (e) => ({ name: n, ok: false, error: String((e && e.message) || "check failed").slice(0, 200) })
    )
  ));

  const checks = {};
  let maxDanger = 0;
  // riskiestCheck is the check driving the overall verdict — the riskiest
  // finding is always drawn from THIS check, so the headline and the
  // highlight can never disagree (L2).
  let riskiestCheck = null;
  let okCount = 0;
  const failedNames = [];
  for (const r of results) {
    if (!r.ok) { checks[r.name] = { error: r.error }; failedNames.push(r.name); continue; }
    okCount++;
    const d = preflightDanger(r.name, r.out);
    if (d > maxDanger) { maxDanger = d; riskiestCheck = r; }
    checks[r.name] = slimCheck(r.name, r.out);
  }
  if (!wallet) checks["approval-risk"] = { skipped: "pass ?wallet=0x… to include the wallet approval audit" };
  const riskiest = riskiestCheck ? worstFindingOf(riskiestCheck.name, riskiestCheck.out) : null;

  let overall, summary;
  if (okCount === 0) {
    overall = "proceed with caution";
    summary = "Every upstream check failed — no signal either way. Try again shortly; do not treat this as a clearance.";
  } else {
    overall = maxDanger >= 3 ? "do not touch" : maxDanger >= 1 ? "proceed with caution" : "cleared for takeoff";
    // M1: a silently failed sub-check can never ride along on a clearance —
    // cap at caution and name the check that didn't run.
    if (failedNames.length && overall === "cleared for takeoff") overall = "proceed with caution";
    const failedNote = failedNames.length
      ? ` ${failedNames.join(" + ")} did not run (upstream error) — this is not a full clearance.`
      : "";
    summary = overall === "do not touch"
      ? `DO NOT TOUCH: ${riskiest ? riskiest.title.toLowerCase() : "a critical finding"} (${riskiest ? riskiest.check : "checks"}).${failedNote} Heuristic bundle, not an audit.`
      : overall === "proceed with caution"
      ? (failedNames.length
        ? `${failedNames.join(" + ")} did not run (upstream error) — not a full clearance.${riskiest ? ` Also: ${riskiest.title.toLowerCase()} (${riskiest.check}).` : ""} Heuristic bundle, not an audit.`
        : `${riskiest ? `${riskiest.title.toLowerCase()} (${riskiest.check})` : "A flag"} needs your eyes before money moves. Heuristic bundle, not an audit.`)
      : `All ${okCount} checks came back clean. Heuristic bundle, not an audit — read the code before real money.`;
  }

  return {
    chain: ch,
    address: addr,
    wallet: wallet || null,
    overall_verdict: overall,
    riskiest_finding: riskiest,
    checks,
    summary,
    source: "trollbridge verdict bundle: honeypotScreen + rugScore + checkContract (+ approvalRisk)",
    disclaimer: DISCLAIMER,
    note: "Heuristic bundle, not an audit. Not financial advice. Refresh: 5-min cache.",
  };
}

module.exports = {
  honeypotScreen,
  approvalRisk,
  rugScore,
  receiptCheck,
  preflight,
  VERDICT_CHAINS: ["base", "ethereum"],
};
