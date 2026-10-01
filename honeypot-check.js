// TrollBridge /honeypot-check lane — data layer (the $0 edition).
// The premium honeypot screen ($0.10 protection tier): DexScreener buy/sell
// flow analysis (sells≈0 while buys pile up = the classic honeypot shape),
// token holder concentration, PLUS the full /contract-check module reused
// for owner privileges, proxy wiring, selfdestruct, and unrestricted mint.
// The $0.02 /honeypot lane simulates sells; this lane reads the market's
// actual trading behavior and the contract's code on top of it.
//
// HEURISTIC SCREEN, NOT AN AUDIT: pattern matches against public data, not
// a security review. A clean screen does not mean the token is safe.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";
const contractCheck = require("./contract-check");

const CHAINS = ["base", "ethereum"];

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- tiny TTL cache ----
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
const honeyCache = makeCache(15 * 60 * 1000);

const SEV_POINTS = { critical: 40, high: 25, medium: 10, low: 3, info: 0 };
function verdictFor(score) {
  if (score >= 60) return "likely-honeypot";
  if (score >= 30) return "suspicious";
  return "looks-ok";
}

async function honeypotCheck(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… token contract address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!CHAINS.includes(ch)) throw badRequest("chain must be base or ethereum");
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = honeyCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  let out;
  try {
    out = await runHoneypotCheck(addr, ch);
  } catch (e) {
    if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
    throw e;
  }
  out = { generated_at: new Date().toISOString(), cached: false, ...out };
  honeyCache.set(key, out);
  return out;
}

async function runHoneypotCheck(addr, chain) {
  const findings = [];
  let score = 0;
  const add = (pts, severity, code, title, detail) => {
    score += pts;
    findings.push({ severity, code, title, detail });
  };

  // ---- 1. DexScreener buy/sell flow: the market's actual behavior ----
  let flow = null;
  let pairsSeen = 0;
  try {
    const dex = await getJSON(`${DEX_TOKENS}${addr}`, 20000);
    const pairs = ((dex && dex.pairs) || []).filter(
      (p) => (p.chainId || "").toLowerCase() === chain
    );
    pairsSeen = pairs.length;
    let buys = 0, sells = 0, liq = 0;
    for (const p of pairs) {
      const t = (p.txns && p.txns.h24) || {};
      buys += num(t.buys) || 0;
      sells += num(t.sells) || 0;
      liq += num(p.liquidity && p.liquidity.usd) || 0;
    }
    flow = { pairs_tracked: pairs.length, buys_24h: buys, sells_24h: sells, liquidity_usd: Math.round(liq) };
    if (!pairs.length) {
      add(25, "high", "no-dex-pairs", "No DEX pairs tracked", "DexScreener tracks no trading pairs for this token on this chain — there may be nowhere to sell at all, or the token is too new/obscure to have a market.");
    } else if (sells === 0 && buys >= 10) {
      add(40, "critical", "zero-sells", `Zero sells against ${buys} buys in 24h`, "Nobody sold this token in the last 24 hours while buys kept coming — the textbook honeypot shape. Holders appear unable to exit their positions.");
    } else if (buys >= 20 && sells / buys < 0.05) {
      add(25, "high", "sell-drought", `Sell drought: ${sells} sells vs ${buys} buys`, "Almost no selling against heavy buying — exits may be blocked, taxed to zero, or blacklisted. Treat as hostile until proven otherwise.");
    } else if (buys >= 20 && sells / buys < 0.25) {
      add(10, "medium", "weak-sell-flow", `Weak sell flow: ${sells} sells vs ${buys} buys`, "Selling is far below buying — could be hype, could be friction on exits. Worth a closer look before sizing up.");
    }
    if (pairs.length && liq < 10000) {
      add(10, "medium", "thin-liquidity", `Thin liquidity ($${Math.round(liq).toLocaleString()})`, "Very thin liquidity — even small sells move the price hard, and the pool can be drained or pulled cheaply.");
    }
  } catch {
    flow = { note: "DexScreener unreachable — flow analysis skipped", pairs_tracked: 0 };
  }

  // ---- 2. Contract screen, reused: owner privileges, proxy, mint, kill-switches ----
  let contract = null;
  try {
    const cc = await contractCheck.checkContract(addr, chain);
    contract = {
      verified: cc.verified,
      contract_name: cc.contract_name,
      proxy_type: cc.proxy_type,
      holder_concentration: cc.holder_concentration,
      token: cc.token ? { symbol: cc.token.symbol, name: cc.token.name, holders_count: cc.token.holders_count } : null,
    };
    // Fold the contract screen's own score in at full weight — these are the
    // code-level findings (owner privileges, proxy, selfdestruct, mint).
    const ccScore = num(cc.risk_score) || 0;
    score += ccScore;
    for (const f of cc.findings || []) {
      if (["critical", "high"].includes(f.severity)) {
        findings.push({
          severity: f.severity,
          code: `contract:${f.code}`,
          title: f.title,
          detail: f.detail,
        });
      }
    }
    if ((cc.holder_concentration && cc.holder_concentration.top_10_share_pct >= 90)) {
      add(15, "high", "whale-concentration", `Top 10 holders own ${cc.holder_concentration.top_10_share_pct}%`, "Near-total supply concentration on top of the contract findings — insiders can crater the price on exit.");
    }
  } catch (e) {
    if (e && e.statusCode === 400) throw e; // not-a-contract etc: fail loud
    contract = { note: "contract screen unreachable — code heuristics skipped" };
  }

  score = Math.min(100, Math.round(score));
  const verdict = verdictFor(score);
  const worst = findings.find((f) => f.severity === "critical") || findings.find((f) => f.severity === "high") || findings[0];
  const summary =
    verdict === "looks-ok"
      ? `No honeypot shape detected (score ${score}/100): ${flow && flow.pairs_tracked ? `${flow.sells_24h} sells vs ${flow.buys_24h} buys in 24h across ${flow.pairs_tracked} pair${flow.pairs_tracked === 1 ? "" : "s"}` : "no DEX flow data"}${findings.length ? `, ${findings.length} contract note${findings.length === 1 ? "" : "s"}` : ", clean contract screen"}. Heuristic screen, not an audit.`
      : `${verdict === "likely-honeypot" ? "LIKELY HONEYPOT" : "SUSPICIOUS"} (score ${score}/100): ${worst ? worst.title.toLowerCase() : "multiple risk signals"}${findings.length > 1 ? ` +${findings.length - 1} more finding${findings.length > 2 ? "s" : ""}` : ""}. Heuristic screen, not an audit.`;

  return {
    lane: "/honeypot-check",
    chain,
    address: addr,
    verdict,
    risk_score: score,
    flow,
    contract,
    findings,
    summary,
    sources: ["dexscreener keyless api (no key)", "blockscout keyless api via /contract-check reuse (no key)"],
    disclaimer: "Heuristic screen, not an audit: pattern matches against public trading and contract data, not a security review. A clean screen does not mean the token is safe.",
    note: "Refresh: 15-min cache. Flow data is 24h trailing; a brand-new token may show zero sells simply because nobody has tried yet.",
  };
}

module.exports = { honeypotCheck, HONEYPOT_CHECK_CHAINS: CHAINS };
