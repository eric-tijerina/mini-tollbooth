// TrollBridge /contract-check lane — data layer (the $0 edition).
// Contract safety screen from Blockscout's free keyless API (no key, no signup):
// verification status, proxy/implementation wiring, creator, age, tx count,
// plus source-code heuristics when verified (proxy patterns, owner privileges,
// selfdestruct, unrestricted mint, tx.origin, external calls in loops) and an
// EIP-1167 minimal-proxy bytecode fingerprint when not verified. Token holder
// concentration via the Blockscout holders endpoint.
//
// HEURISTIC SCREEN, NOT AN AUDIT: every response carries that wording. These
// are pattern matches, not a security review — a clean screen does not mean
// a contract is safe, and a flagged pattern is not proof of malice.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const BLOCKSCOUT = {
  base: "https://base.blockscout.com/api/v2",
  ethereum: "https://eth.blockscout.com/api/v2",
};
// Public RPCs for eth_getCode only (unverified-contract proxy fingerprint).
// Same keyless lists the /gas lane uses.
const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};
const DISCLAIMER =
  "Heuristic screen, not an audit: pattern matches against public data, not a security review. A clean screen does not mean the contract is safe.";

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (res.status === 404) return null; // unverified contract, unknown token, etc.
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
const checkCache = makeCache(30 * 60 * 1000);

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

// ---- source-code heuristics (verified contracts) ----
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const DANGEROUS_FNS = [
  "mint",
  "pause",
  "unpause",
  "withdraw",
  "sweep",
  "setFee",
  "setTreasury",
  "setMinter",
  "blacklist",
  "upgradeTo",
  "upgradeToAndCall",
  "transferOwnership",
  "renounceOwnership",
  "setOwner",
  "drain",
];
const ACCESS_MODIFIERS = /\b(onlyOwner|onlyRole|onlyAdmin|onlyMinter|onlyGovernance|requiresAuth|auth|onlyGuardian)\b/;

function scanSource(src) {
  const findings = [];
  const code = stripComments(src);

  // 1. selfdestruct — the contract can be killed, funds can be forced out.
  if (/\bselfdestruct\s*\(/.test(code)) {
    findings.push({
      severity: "critical",
      code: "selfdestruct",
      title: "selfdestruct present",
      detail: "The contract can destroy itself and force-send its balance to an arbitrary address. A compromised owner key can rug every holder in one transaction.",
      pattern: "selfdestruct(",
    });
  }

  // 2. tx.origin for auth — phishable.
  if (/\btx\.origin\b/.test(code)) {
    findings.push({
      severity: "high",
      code: "tx-origin",
      title: "tx.origin used",
      detail: "tx.origin is used somewhere in the code. If it gates authorization, a phishing contract can impersonate the victim and pass the check.",
      pattern: "tx.origin",
    });
  }

  // 3. Owner-privileged dangerous functions.
  const seen = new Set();
  for (const fn of DANGEROUS_FNS) {
    const re = new RegExp(`function\\s+${fn}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(code)) !== null) {
      if (seen.has(fn)) break;
      seen.add(fn);
      // Look at the signature region (up to the opening brace) for access control.
      const region = code.slice(m.index, m.index + 400).split("{")[0];
      const guarded = ACCESS_MODIFIERS.test(region);
      findings.push({
        severity: guarded ? "medium" : "high",
        code: guarded ? "owner-privilege" : "unrestricted-dangerous-fn",
        title: guarded ? `Owner can call ${fn}()` : `UNRESTRICTED ${fn}() — anyone can call it`,
        detail: guarded
          ? `${fn}() is restricted to a privileged role, but a single compromised key can invoke it. Check who holds that role.`
          : `${fn}() has no visible access control in its signature — anyone may be able to call it. Treat as hostile until proven otherwise.`,
        pattern: `function ${fn}(`,
      });
      break;
    }
  }

  // 4. Unrestricted mint: any mint* function with no access control.
  // (Exact `mint` was already handled above; this catches mintTo, rugMint…)
  const mintAnyRe = /function\s+([A-Za-z0-9_]*[Mm][Ii][Nn][Tt][A-Za-z0-9_]*)\s*\(/g;
  let mm;
  while ((mm = mintAnyRe.exec(code)) !== null) {
    const name = mm[1];
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const region = code.slice(mm.index, mm.index + 400).split("{")[0];
    if (!ACCESS_MODIFIERS.test(region)) {
      findings.push({
        severity: "high",
        code: "unrestricted-mint",
        title: `UNRESTRICTED ${name}() — anyone can mint`,
        detail: `${name}() has no visible access control in its signature — anyone may be able to mint new tokens and dilute holders to zero. Treat as hostile until proven otherwise.`,
        pattern: `function ${name}(`,
      });
    }
  }

  // 5. External calls inside loops — reentrancy / gas-griefing surface.
  const loopRe = /for\s*\([^)]*\)\s*\{/g;
  let lm;
  let loopFlagged = false;
  while ((lm = loopRe.exec(code)) !== null && !loopFlagged) {
    const body = code.slice(lm.index, lm.index + 1500);
    if (/(\.call\s*\{|\.transfer\s*\(|\.send\s*\()/.test(body)) {
      loopFlagged = true;
      findings.push({
        severity: "medium",
        code: "external-call-in-loop",
        title: "External call inside a loop",
        detail: "A loop body makes external calls (.call/.transfer/.send). A failing or malicious callee can grief the whole loop; review for reentrancy guards.",
        pattern: "for (...) { ... .call{...}(...) ... }",
      });
    }
  }

  // 6. delegatecall to a non-fixed target — implementation can be swapped.
  if (/\bdelegatecall\s*\(/.test(code) && !/TransparentUpgradeableProxy|ERC1967Proxy|UUPSUpgradeable|AdminUpgradeabilityProxy/.test(code)) {
    findings.push({
      severity: "medium",
      code: "delegatecall",
      title: "delegatecall in logic",
      detail: "The code uses delegatecall outside a recognized proxy scaffold. If the target address is controllable, an attacker can execute arbitrary code in this contract's storage context.",
      pattern: "delegatecall(",
    });
  }

  return findings;
}

// ---- EIP-1167 minimal proxy fingerprint (unverified contracts) ----
const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
function isMinimalProxy(bytecode) {
  if (!bytecode || typeof bytecode !== "string") return false;
  const b = bytecode.toLowerCase();
  return b.startsWith(EIP1167_PREFIX) && b.includes(EIP1167_SUFFIX) && b.length <= 200;
}

// ---- risk scoring ----
const SEV_POINTS = { critical: 40, high: 25, medium: 10, low: 3, info: 0 };
function riskLevel(score) {
  if (score >= 60) return "critical";
  if (score >= 30) return "high";
  if (score >= 10) return "medium";
  return "low";
}

async function checkContract(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  const api = BLOCKSCOUT[ch];
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = checkCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  let out;
  try {
    out = await runCheck(api, ch, addr);
  } catch (e) {
    if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
    throw e;
  }
  out = { generated_at: new Date().toISOString(), cached: false, ...out };
  checkCache.set(key, out);
  return out;
}

async function runCheck(api, chain, addr) {
  const info = await getJSON(`${api}/addresses/${addr}`);
  if (!info) throw badRequest("address not found on this chain — check the address and chain");
  if (!info.is_contract) throw badRequest("address is not a contract (no bytecode) — nothing to screen");

  const findings = [];
  const verified = info.is_verified === true;

  // Blockscout's own scam/reputation flags.
  if (info.is_scam === true) {
    findings.push({
      severity: "critical",
      code: "blockscout-scam-flag",
      title: "Blockscout flags this address as a scam",
      detail: "Blockscout's own reputation feed marks this contract as a scam. Do not interact.",
      pattern: "is_scam=true (Blockscout)",
    });
  }

  // Proxy wiring straight from Blockscout (primary), source patterns as backup.
  const proxyType = info.proxy_type || null;
  const implementations = (info.implementations || []).map((i) => ({
    address: i.address_hash || null,
    name: i.name || null,
  }));
  if (proxyType) {
    findings.push({
      severity: "medium",
      code: "upgradeable-proxy",
      title: `Upgradeable proxy (${proxyType})`,
      detail: `The contract is an upgradeable proxy${implementations.length ? ` → implementation ${implementations[0].name || implementations[0].address}` : ""}. The admin can swap the logic contract at any time — today's safe code can become tomorrow's rug. Check who the admin is before trusting it.`,
      pattern: `proxy_type=${proxyType} (Blockscout)`,
    });
  }

  // Creator + age + activity.
  const creator = info.creator_address_hash || null;
  let deployed_at = null;
  if (info.creation_transaction_hash) {
    try {
      const tx = await getJSON(`${api}/transactions/${info.creation_transaction_hash}`);
      if (tx && tx.timestamp) deployed_at = tx.timestamp;
    } catch { /* age is a bonus, not a blocker */ }
  }
  let transaction_count = null;
  try {
    const counters = await getJSON(`${api}/addresses/${addr}/counters`);
    if (counters) transaction_count = num(counters.transactions_count);
  } catch { /* same */ }

  // Verification + source heuristics.
  let contract_name = info.name || null;
  let compiler = null;
  if (!verified) {
    findings.push({
      severity: "high",
      code: "unverified",
      title: "Contract source is NOT verified",
      detail: "No source code is published for this contract — you cannot read what it does. Unverified contracts are the single most common shape of on-chain scams. Only interact if you fetched and audited the bytecode yourself.",
      pattern: "is_verified=false (Blockscout)",
    });
    // EIP-1167 minimal-proxy fingerprint on the raw bytecode.
    try {
      const code = await rpcCall(EVM_RPCS[chain], "eth_getCode", [addr, "latest"]);
      if (isMinimalProxy(code)) {
        findings.push({
          severity: "medium",
          code: "minimal-proxy",
          title: "Minimal proxy (EIP-1167) bytecode",
          detail: "The bytecode matches the EIP-1167 minimal-proxy fingerprint — this contract forwards everything to an implementation contract. Find and screen the implementation before interacting.",
          pattern: "363d3d373d3d3d363d73…5af43d82803e903d91602b57fd5bf3",
        });
      }
    } catch { /* fingerprint is a bonus */ }
  } else {
    try {
      const sc = await getJSON(`${api}/smart-contracts/${addr}`);
      if (sc) {
        contract_name = sc.name || contract_name;
        compiler = sc.compiler_version || sc.language || null;
        const src = sc.source_code || "";
        if (src) findings.push(...scanSource(src));
        else {
          findings.push({
            severity: "low",
            code: "no-source-returned",
            title: "Verified but source unavailable",
            detail: "Blockscout marks the contract verified but returned no source code — heuristics could not run. Treat verification as unconfirmed.",
            pattern: "is_verified=true, empty source_code",
          });
        }
      }
    } catch { /* source fetch failed; verification still counts */ }
  }

  // Token holder concentration.
  const token = info.token || null;
  let holder_concentration = null;
  if (token && (token.type === "ERC-20" || token.type === "ERC-20 ")) {
    try {
      const holders = await getJSON(`${api}/tokens/${addr}/holders`);
      const items = (holders && holders.items) || [];
      const decimals = num(token.decimals) || 0;
      const totalRaw = num(token.total_supply);
      if (items.length && totalRaw) {
        const top = items.slice(0, 10);
        const topSum = top.reduce((s, h) => s + (num(h.value) || 0), 0);
        const share = (topSum / totalRaw) * 100;
        holder_concentration = {
          holders_tracked: items.length,
          top_10_share_pct: +share.toFixed(2),
          note: "Share of total supply held by the 10 largest holders.",
        };
        if (share >= 90) {
          findings.push({
            severity: "high",
            code: "holder-concentration",
            title: `Top 10 holders own ${share.toFixed(1)}% of supply`,
            detail: "Near-total supply concentration — a coordinated dump by insiders can crater the price. Classic rug shape.",
            pattern: "top_10_share_pct>=90",
          });
        } else if (share >= 70) {
          findings.push({
            severity: "medium",
            code: "holder-concentration",
            title: `Top 10 holders own ${share.toFixed(1)}% of supply`,
            detail: "Heavy insider concentration — large holders can move the price hard on exit.",
            pattern: "top_10_share_pct>=70",
          });
        }
      }
    } catch { /* concentration is a bonus */ }
  }

  const score = Math.min(100, findings.reduce((s, f) => s + (SEV_POINTS[f.severity] || 0), 0));
  const risk = riskLevel(score);
  const worst = findings.find((f) => f.severity === "critical") || findings[0];

  const summary = !findings.length
    ? `Clean heuristic screen: verified${proxyType ? ", upgradeable proxy" : ""}${token ? `, ${token.symbol || "token"}` : ""}. Still not an audit — read the code before real money.`
    : `${risk.toUpperCase()} risk (${score}/100): ${worst.title.toLowerCase()}${findings.length > 1 ? ` +${findings.length - 1} more finding${findings.length > 2 ? "s" : ""}` : ""}. Heuristic screen, not an audit.`;

  return {
    chain,
    address: addr,
    contract_name,
    verified,
    proxy_type: proxyType,
    implementations,
    creator_address: creator,
    deployed_at,
    transaction_count,
    token: token
      ? { name: token.name, symbol: token.symbol, type: token.type, decimals: num(token.decimals), total_supply: token.total_supply, holders_count: num(token.holders_count) }
      : null,
    holder_concentration,
    risk,
    risk_score: score,
    findings,
    summary,
    compiler,
    source: "blockscout keyless api (no key)",
    disclaimer: DISCLAIMER,
    note: "Heuristic screen, not an audit. Refresh: 30-min cache.",
  };
}

module.exports = { checkContract, CONTRACT_CHECK_CHAINS: Object.keys(BLOCKSCOUT) };
