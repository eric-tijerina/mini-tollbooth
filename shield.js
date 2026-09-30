// TrollBridge skill-moat batch — data layer (the insurance man's new tools).
// Five derived-verdict lanes for work that takes other agents forever:
//   /tx-dryrun        — the crystal ball: simulate + explain a transaction in
//                      plain words before signing. Verdict: safe / review-carefully / do-not-sign.
//   /permit-scan      — the invisible drainer: Permit2/Seaport exposure plus
//                      the standard approval audit. Verdict: clean / exposed / urgent.
//   /airdrop-verdict  — legit or drainer: static page forensics on a claim URL.
//                      Verdict: likely-legit / suspicious / likely-drainer.
//   /deployer-history — who made this token, and what else did they make.
//                      Verdict: clean / mixed / serial-rugger.
//   /wallet-watch     — has anything changed: stateful monitoring via a
//                      baseline token the agent passes back. Verdict:
//                      baseline / no-changes / changed (+ diff).
//
// HEURISTIC VERDICTS, NOT AUDITS: every response carries that wording. These
// are pattern matches against public on-chain data, not security reviews —
// a clean verdict does not mean an asset is safe.
const crypto = require("crypto");
const dns = require("dns/promises");
const contractCheck = require("./contract-check");

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
const DISCLAIMER =
  "Heuristic verdict from public on-chain data — not financial advice and not a security audit. Verify independently before moving funds.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVE_SEL = "0x095ea7b3";
const TRANSFER_SEL = "0xa9059cbb";
const TRANSFERFROM_SEL = "0x23b872dd";
const ALLOWANCE_SEL = "0xdd62ed3e";
const BALANCEOF_SEL = "0x70a08231";
const SETAPPROVALFORALL_SEL = "0xa22cb465";
const NAME_SEL = "0x06fdde03";
const SYMBOL_SEL = "0x95d89b41";
const DECIMALS_SEL = "0x313ce567";
const UNLIMITED_ALLOWANCE = 1n << 255n;
const MAX_UINT256 = (1n << 256n) - 1n;

// Permit-capable contracts whose past interaction means "this wallet has
// signed the invisible stuff before".
const PERMIT_CAPABLE = {
  "0x000000000022d473030f6466dd3f6a8b9e3e5e5": "Permit2",
  "0x00000000000000adc04c56bf30ac9b969048f744": "Seaport 1.5",
  "0x0000000000000068f116a84403cb8ea52e0681": "Seaport 1.6",
};

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
function getJSONFast(url) {
  return getJSON(url, 12000);
}

// Raw JSON-RPC that distinguishes an on-chain revert from a dead RPC:
// { transportOk, reverted, result?, error? }.
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
function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}
function padAddr(a) {
  return a.toLowerCase().replace("0x", "").padStart(64, "0");
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
function shortAddr(a) {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function checkChain(chain) {
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT[ch]) throw badRequest("chain must be base or ethereum");
  return ch;
}

// ====================================================================
// Shared: compact approval scan (approve() calls in recent history +
// live allowance checks). Lighter than verdicts.js approvalRisk — no
// token-symbol lookups, paced RPC calls.
// ====================================================================
async function spenderNature(chain, api, spender) {
  const out = { is_contract: false, verified: null, is_scam: false, name: null };
  try {
    const code = await rpcCall(EVM_RPCS[chain], "eth_getCode", [spender, "latest"]);
    out.is_contract = !!(code && code !== "0x" && code !== "0x0");
  } catch {
    /* unknown */
  }
  if (out.is_contract) {
    try {
      const si = await getJSON(`${api}/addresses/${spender}`);
      if (si) {
        out.verified = si.is_verified === true;
        out.is_scam = si.is_scam === true;
        out.name = si.name || null;
      }
    } catch {
      /* best effort */
    }
  }
  await sleep(350);
  return out;
}

async function scanApprovals(wallet, chain) {
  const api = BLOCKSCOUT[chain];
  const txPage = await getJSON(`${api}/addresses/${wallet}/transactions`);
  const items = (txPage && txPage.items) || [];
  const seen = new Map();
  for (const t of items) {
    const input = t.raw_input || t.input || "";
    if (!input.startsWith(APPROVE_SEL) || input.length < 138) continue;
    const token = t.to && t.to.hash ? t.to.hash : null;
    if (!token || !isAddress(token)) continue;
    const spender = "0x" + input.slice(34, 74);
    if (!isAddress(spender)) continue;
    const k = `${token.toLowerCase()}:${spender.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, { token, spender, tx_hash: t.hash });
    if (seen.size >= 25) break;
  }

  const approvals = [];
  const natureCache = new Map();
  for (const { token, spender, tx_hash } of seen.values()) {
    let allowance = null;
    let readable = true;
    try {
      const data = ALLOWANCE_SEL + padAddr(wallet) + padAddr(spender);
      const res = await rpcCall(EVM_RPCS[chain], "eth_call", [{ to: token, data }, "latest"]);
      allowance = BigInt(res || "0x0");
    } catch {
      readable = false;
    }
    let nature;
    const nk = spender.toLowerCase();
    if (natureCache.has(nk)) nature = natureCache.get(nk);
    else {
      nature = await spenderNature(chain, api, spender);
      natureCache.set(nk, nature);
    }
    const unlimited = allowance !== null && allowance >= UNLIMITED_ALLOWANCE;
    const risky = nature.is_scam || !nature.is_contract || nature.verified === false;
    let priority = "info";
    let reason = "limited allowance";
    if (unlimited && risky) {
      priority = "urgent";
      reason = nature.is_scam
        ? "unlimited allowance to a Blockscout-flagged scam contract"
        : !nature.is_contract
          ? "unlimited allowance to an externally-owned account (not a contract)"
          : "unlimited allowance to an unverified contract";
    } else if (unlimited) {
      priority = "review";
      reason = "unlimited allowance to a verified contract — fine until it is upgraded or exploited";
    } else if (readable && risky && allowance > 0n) {
      priority = "review";
      reason = "allowance to an unverified contract or EOA";
    }
    approvals.push({
      token,
      spender,
      spender_name: nature.name,
      spender_is_contract: nature.is_contract,
      spender_verified: nature.verified,
      unlimited,
      priority,
      reason,
      approve_tx: tx_hash,
    });
  }
  const counts = { urgent: 0, review: 0, info: 0 };
  for (const a of approvals) counts[a.priority] = (counts[a.priority] || 0) + 1;
  return { approvals, counts, txs_scanned: items.length };
}

function revokeList(approvals) {
  return approvals
    .filter((a) => a.priority === "urgent" || a.priority === "review")
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "urgent" ? -1 : 1))
    .map((a) => ({ token: a.token, spender: a.spender, priority: a.priority, reason: a.reason }));
}

// Permit-capable exposure: has this wallet ever touched Permit2 / Seaport?
async function permitExposure(wallet, chain) {
  const api = BLOCKSCOUT[chain];
  const txPage = await getJSONFast(`${api}/addresses/${wallet}/transactions`);
  const items = (txPage && txPage.items) || [];
  const hits = [];
  for (const t of items) {
    const to = t.to && t.to.hash ? t.to.hash.toLowerCase() : null;
    if (to && PERMIT_CAPABLE[to]) {
      hits.push({ contract: PERMIT_CAPABLE[to], address: t.to.hash, tx_hash: t.hash, when: t.timestamp || null });
      if (hits.length >= 10) break;
    }
  }
  return { exposed: hits.length > 0, interactions: hits, txs_scanned: items.length };
}

// ====================================================================
// /tx-dryrun — the crystal ball: simulate + explain in plain words.
// ====================================================================
const dryrunCache = makeCache(10 * 60 * 1000);

function decodeCalldata(data) {
  const d = (data || "").toLowerCase();
  if (!d.startsWith("0x") || d.length < 10) return { selector: null, known: false };
  const sel = d.slice(0, 10);
  const words = [];
  for (let i = 10; i + 64 <= d.length && words.length < 12; i += 64) words.push(d.slice(i, i + 64));
  const wAddr = (w) => (w ? "0x" + w.slice(-40) : null);
  const wUint = (w) => (w ? BigInt("0x" + w).toString() : null);
  switch (sel) {
    case APPROVE_SEL:
      return { selector: sel, name: "approve", known: true, spender: wAddr(words[0]), amount: wUint(words[1]), amount_raw: words[1] };
    case TRANSFER_SEL:
      return { selector: sel, name: "transfer", known: true, to: wAddr(words[0]), amount: wUint(words[1]) };
    case TRANSFERFROM_SEL:
      return { selector: sel, name: "transferFrom", known: true, from: wAddr(words[0]), to: wAddr(words[1]), amount: wUint(words[2]) };
    case SETAPPROVALFORALL_SEL:
      return { selector: sel, name: "setApprovalForAll", known: true, operator: wAddr(words[0]), approved: words[1] !== "0".repeat(64) };
    case "0x39509351":
      return { selector: sel, name: "increaseAllowance", known: true, spender: wAddr(words[0]), added: wUint(words[1]) };
    case "0xa457c2d7":
      return { selector: sel, name: "decreaseAllowance", known: true, spender: wAddr(words[0]), subtracted: wUint(words[1]) };
    case "0xd505accf":
      return { selector: sel, name: "permit", known: true, owner: wAddr(words[0]), spender: wAddr(words[1]), value: wUint(words[2]) };
    case "0x7ff36ab5":
      return { selector: sel, name: "swapExactETHForTokens", known: true, note: "swap native currency for tokens" };
    case "0x38ed1739":
      return { selector: sel, name: "swapExactTokensForTokens", known: true, note: "swap tokens for tokens" };
    case "0x18cbafe5":
      return { selector: sel, name: "swapExactTokensForETH", known: true, note: "swap tokens for native currency" };
    case "0xac9650d8":
      return { selector: sel, name: "multicall", known: true, note: "bundles multiple calls — each inner call needs its own review" };
    case "0xd0e30db0":
      return { selector: sel, name: "deposit (WETH wrap)", known: true, note: "wraps native currency to WETH" };
    case "0x2e1a7d4d":
      return { selector: sel, name: "withdraw (WETH unwrap)", known: true, amount: wUint(words[0]) };
    default:
      return { selector: sel, known: false };
  }
}

async function tokenMeta(chain, token) {
  const meta = { address: token, name: null, symbol: null, decimals: null };
  for (const [sel, key] of [[NAME_SEL, "name"], [SYMBOL_SEL, "symbol"]]) {
    try {
      const r = await rpcCall(EVM_RPCS[chain], "eth_call", [{ to: token, data: sel }, "latest"], 8000);
      if (r && r !== "0x") {
        const hex = r.startsWith("0x") ? r.slice(2) : r;
        // string return: offset(64) + length(64) + data
        if (hex.length >= 128) {
          const len = parseInt(hex.slice(64, 128), 16);
          const str = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "");
          meta[key] = str.slice(0, 32) || null;
        }
      }
    } catch { /* best effort */ }
  }
  try {
    const r = await rpcCall(EVM_RPCS[chain], "eth_call", [{ to: token, data: DECIMALS_SEL }, "latest"], 8000);
    if (r && r !== "0x") meta.decimals = parseInt(r, 16);
  } catch { /* best effort */ }
  return meta;
}

function fmtAmount(amount, decimals, symbol) {
  if (amount == null) return symbol ? `some ${symbol}` : "some tokens";
  try {
    const bn = BigInt(amount);
    if (bn >= UNLIMITED_ALLOWANCE) return symbol ? `UNLIMITED ${symbol}` : "an UNLIMITED amount";
    if (decimals != null && decimals <= 36) {
      const whole = bn / (10n ** BigInt(decimals));
      const frac = bn % (10n ** BigInt(decimals));
      const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
      return `${whole.toString()}${fracStr ? "." + fracStr : ""}${symbol ? " " + symbol : ""}`;
    }
    return `${bn.toString()}${symbol ? " " + symbol : " base units"}`;
  } catch {
    return symbol ? `some ${symbol}` : "some tokens";
  }
}

async function runDryrun(to, data, from, value, chain) {
  const t = (to || "").trim();
  const f = (from || "").trim();
  const d = (data || "").trim();
  if (!isAddress(t)) throw badRequest("to must be a 0x… contract address (40 hex chars)");
  if (!isAddress(f)) throw badRequest("from must be a 0x… wallet address (40 hex chars)");
  if (!/^0x[0-9a-fA-F]*$/.test(d) || d.length < 10) throw badRequest("data must be hex calldata starting with 0x");
  const ch = checkChain(chain);
  let val = 0n;
  try {
    const v = (value || "0").toString().trim();
    val = v.startsWith("0x") ? BigInt(v) : BigInt(v);
    if (val < 0n) throw new Error();
  } catch {
    throw badRequest("value must be a non-negative integer (wei) or 0x… hex");
  }

  const decoded = decodeCalldata(d);
  const meta = await tokenMeta(ch, t);
  const sym = meta.symbol;

  // The simulation itself: would this exact call revert right now?
  const sim = await rpcRaw(EVM_RPCS[ch], "eth_call", [{ from: f, to: t, data: d, value: "0x" + val.toString(16) }, "latest"]);
  const simResult = sim.transportOk
    ? { ok: true, reverted: sim.reverted, revert_reason: sim.reverted ? sim.error : null }
    : { ok: false, reverted: null, revert_reason: "simulation RPCs unreachable — could not test the call" };

  const reasons = [];
  let verdict = "safe";
  let explanation = "";

  const flagSpender = async (spender, kind) => {
    if (!spender || !isAddress(spender)) return null;
    const n = await spenderNature(ch, BLOCKSCOUT[ch], spender);
    return { spender, kind, ...n };
  };

  if (!simResult.ok) {
    verdict = "review-carefully";
    explanation = "The simulation could not reach an RPC — this verdict rests on the calldata reading alone, not a live test.";
    reasons.push("simulation RPCs unreachable");
  } else if (simResult.reverted) {
    verdict = "review-carefully";
    explanation = `This transaction REVERTED in simulation${simResult.revert_reason ? ` (${simResult.revert_reason})` : ""} — as written it would fail on-chain and burn gas, or the simulation inputs don't match real conditions.`;
    reasons.push("reverted in simulation");
  }

  if (decoded.known) {
    const unlimitedAmt = (a) => { try { return BigInt("0x" + a) >= UNLIMITED_ALLOWANCE; } catch { return false; } };
    if (decoded.name === "approve" || decoded.name === "increaseAllowance") {
      const amt = decoded.amount || decoded.added;
      const unl = unlimitedAmt(decoded.amount_raw);
      const nat = await flagSpender(decoded.spender, decoded.name);
      const amtTxt = unl ? `UNLIMITED ${sym || "tokens"}` : fmtAmount(amt, meta.decimals, sym);
      explanation = `This grants ${shortAddr(decoded.spender)} the right to move up to ${amtTxt} from ${shortAddr(f)}${unl ? " — an unlimited grant means they can drain the full balance without asking again" : ""}.`;
      reasons.push(`${decoded.name} → ${shortAddr(decoded.spender)} (${unl ? "unlimited" : "limited"})`);
      if (nat && (nat.is_scam || !nat.is_contract || nat.verified === false)) {
        verdict = "do-not-sign";
        reasons.push(nat.is_scam ? "spender is Blockscout-flagged as a scam" : !nat.is_contract ? "spender is an EOA, not a contract" : "spender contract is unverified");
        explanation += ` ${nat.is_scam ? "That spender is flagged as a SCAM —" : !nat.is_contract ? "That spender is a plain wallet, not a contract —" : "That contract is unverified —"} signing this hands your tokens to it.`;
      } else if (unl && verdict !== "do-not-sign") {
        verdict = "review-carefully";
        reasons.push("unlimited grant to a verified contract — safe until the contract is upgraded or exploited");
        explanation += " The contract is verified, but unlimited grants stay dangerous if it is ever upgraded or exploited — prefer approving exactly what the swap needs.";
      }
    } else if (decoded.name === "transfer") {
      explanation = `This sends ${fmtAmount(decoded.amount, meta.decimals, sym)} from ${shortAddr(f)} to ${shortAddr(decoded.to)}. Simple transfer — the main risk is sending to the wrong address.`;
      reasons.push(`transfer → ${shortAddr(decoded.to)}`);
    } else if (decoded.name === "transferFrom") {
      explanation = `This moves ${fmtAmount(decoded.amount, meta.decimals, sym)} from ${shortAddr(decoded.from)} to ${shortAddr(decoded.to)} — transferFrom only works if ${shortAddr(decoded.from)} already approved the caller.`;
      reasons.push(`transferFrom ${shortAddr(decoded.from)} → ${shortAddr(decoded.to)}`);
      if (verdict === "safe") verdict = "review-carefully";
    } else if (decoded.name === "setApprovalForAll") {
      const nat = await flagSpender(decoded.operator, "setApprovalForAll");
      explanation = decoded.approved
        ? `This grants ${shortAddr(decoded.operator)} approval over ALL of your NFTs on this contract — every token, movable at will.`
        : `This REVOKES ${shortAddr(decoded.operator)}'s approval over all your NFTs here — this one reduces risk.`;
      reasons.push(`setApprovalForAll(${shortAddr(decoded.operator)}, ${decoded.approved})`);
      if (decoded.approved) {
        if (nat && (nat.is_scam || nat.verified === false)) {
          verdict = "do-not-sign";
          reasons.push("operator is unverified or scam-flagged");
        } else if (verdict === "safe") {
          verdict = "review-carefully";
          reasons.push("blanket NFT approval — powerful even when the operator looks fine");
        }
      }
    } else if (decoded.name === "permit") {
      const nat = await flagSpender(decoded.spender, "permit");
      explanation = `This is a signature-based permit: it lets ${shortAddr(decoded.spender)} move up to ${fmtAmount(decoded.value, meta.decimals, sym)} of ${shortAddr(decoded.owner)}'s tokens WITHOUT a visible on-chain approval. Permits are the invisible drainer — they don't show up in normal approval scans.`;
      reasons.push(`permit → ${shortAddr(decoded.spender)} (signature-based, invisible to approval scans)`);
      if (nat && (nat.is_scam || nat.verified === false)) {
        verdict = "do-not-sign";
        reasons.push("permit spender is unverified or scam-flagged");
      } else if (verdict === "safe") {
        verdict = "review-carefully";
        reasons.push("permits bypass on-chain approval history — verify the spender off-chain");
      }
    } else if (decoded.name.startsWith("swap")) {
      explanation = `This is a token swap routed through ${shortAddr(t)}. ${val > 0n ? "It also sends native currency with the call. " : ""}Swaps are routine — the risks are slippage, a malicious router, or a honeypot token on the other side.`;
      reasons.push(`${decoded.name} via ${shortAddr(t)}`);
    } else if (decoded.name === "multicall") {
      verdict = verdict === "safe" ? "review-carefully" : verdict;
      explanation = "This bundles multiple calls into one transaction — the bundle is only as safe as its riskiest inner call, and this lane cannot see inside it. Review each inner call separately.";
      reasons.push("multicall — inner calls not decoded");
    } else {
      explanation = `This calls ${decoded.name} on ${shortAddr(t)}${val > 0n ? ` and sends ${val.toString()} wei of native currency` : ""}. Recognized function, standard behavior.`;
      reasons.push(`${decoded.name} on ${shortAddr(t)}`);
    }
  } else {
    if (verdict === "safe") verdict = "review-carefully";
    explanation = `The function selector ${decoded.selector} is not in the known set — this calls an unrecognized function on ${shortAddr(t)}${val > 0n ? ` and sends ${val.toString()} wei` : ""}. Unrecognized does not mean malicious, but you are signing blind.`;
    reasons.push(`unknown selector ${decoded.selector}`);
  }

  if (val > 0n && verdict === "safe") {
    verdict = "review-carefully";
    reasons.push("transaction carries native currency value");
  }

  return {
    chain: ch,
    from: f,
    to: t,
    value_wei: val.toString(),
    decoded: { function: decoded.name || "unknown", selector: decoded.selector, ...decoded, name: undefined },
    token: meta,
    simulation: simResult,
    verdict,
    explanation,
    reasons,
    source: "public rpc eth_call simulation + calldata decoding (no key)",
    disclaimer: DISCLAIMER,
    note: "Simulation, not a guarantee — state-changing behavior can differ at execution time (front-running, price moves, block conditions). Heuristic screen, not an audit.",
  };
}

async function txDryrun(to, data, from, value, chain) {
  const key = `dryrun:${(chain || "base").toLowerCase()}:${(to || "").toLowerCase()}:${(from || "").toLowerCase()}:${(data || "").slice(0, 74)}`;
  return withCache(dryrunCache, key, () => runDryrun(to, data, from, value, chain));
}

// ====================================================================
// /permit-scan — the invisible drainer: Permit2/Seaport exposure plus
// the standard approval audit.
// ====================================================================
const permitCache = makeCache(10 * 60 * 1000);

async function runPermitScan(wallet, chain) {
  const w = (wallet || "").trim();
  if (!isAddress(w)) throw badRequest("wallet must be a 0x… address (40 hex chars)");
  const ch = checkChain(chain);
  const [scan, exposure] = await Promise.all([scanApprovals(w, ch), permitExposure(w, ch)]);
  const verdict = scan.counts.urgent > 0 ? "urgent" : (exposure.exposed || scan.counts.review > 0) ? "exposed" : "clean";
  const summary =
    verdict === "clean"
      ? "Clean: no permit-capable interactions found and no risky approvals in recent history."
      : verdict === "urgent"
        ? `URGENT: ${scan.counts.urgent} unlimited approval(s) to risky spenders — revoke first.`
        : `EXPOSED: ${exposure.exposed ? `touched ${[...new Set(exposure.interactions.map((i) => i.contract))].join(", ")} before (signature-based risk)` : ""}${exposure.exposed && scan.counts.review > 0 ? " and " : ""}${scan.counts.review > 0 ? `${scan.counts.review} approval(s) worth reviewing` : ""}.`;
  return {
    chain: ch,
    wallet: w,
    verdict,
    permit2_seaport_exposure: exposure,
    approvals_found: scan.approvals.length,
    approval_counts: scan.counts,
    revoke_priority: revokeList(scan.approvals),
    summary,
    source: "blockscout keyless api + public rpc eth_call (no key)",
    disclaimer: DISCLAIMER,
    note: "Flags interaction history with Permit2/Seaport plus standard on-chain approvals. Honest limit: Permit2 signature allowances cannot be enumerated keyless — this catches what happened on-chain, not every live signature.",
  };
}

async function permitScan(wallet, chain) {
  const key = `permitscan:${(chain || "base").toLowerCase()}:${(wallet || "").toLowerCase()}`;
  return withCache(permitCache, key, () => runPermitScan(wallet, chain));
}

// ====================================================================
// /airdrop-verdict — legit or drainer: static page forensics.
// ====================================================================
const airdropCache = makeCache(30 * 60 * 1000);

// brand -> official domain. Domain contains the brand but ISN'T the official
// domain (or its subdomain) => lookalike.
const BRANDS = {
  uniswap: "uniswap.org", aave: "aave.com", compound: "compound.finance",
  curve: "curve.fi", lido: "lido.fi", eigenlayer: "eigenlayer.xyz",
  arbitrum: "arbitrum.io", optimism: "optimism.io", base: "base.org",
  zksync: "zksync.io", starknet: "starknet.io", polygon: "polygon.technology",
  chainlink: "chain.link", sky: "sky.money", pendle: "pendle.finance",
  jupiter: "jup.ag", hyperliquid: "hyperliquid.xyz", blur: "blur.io",
  opensea: "opensea.io", metamask: "metamask.io", coinbase: "coinbase.com",
};

function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

async function runAirdropVerdict(rawUrl) {
  const u = (rawUrl || "").trim();
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw badRequest("url must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("url must use http or https");
  }
  const host = parsed.hostname.toLowerCase();
  // SSRF guard: resolve and refuse private/loopback/link-local targets.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw badRequest("url hostname does not resolve");
  }
  if (addrs.some((a) => isPrivateIP(a.address))) {
    throw badRequest("url resolves to a private address — refused");
  }

  const flags = [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let html = "";
  let finalUrl = u;
  try {
    const res = await fetch(u, { headers: UA, signal: ctrl.signal, redirect: "follow" });
    finalUrl = res.url || u;
    if (!res.ok) throw new Error(`page returned ${res.status}`);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      flags.push({ kind: "content-type", detail: `page is not HTML (${ct.slice(0, 40) || "unknown"}) — nothing to forensically review` });
    }
    html = (await res.text()).slice(0, 500000);
  } finally {
    clearTimeout(t);
  }

  const finalHost = (() => { try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return host; } })();
  const lower = html.toLowerCase();

  // 1. Brand lookalike on the final domain.
  let brandHit = null;
  for (const [brand, official] of Object.entries(BRANDS)) {
    if (finalHost.includes(brand) && finalHost !== official && !finalHost.endsWith("." + official)) {
      brandHit = { brand, official, domain: finalHost };
      break;
    }
  }
  if (brandHit) {
    flags.push({ kind: "lookalike-domain", detail: `domain "${finalHost}" borrows the "${brandHit.brand}" name but is not the official ${brandHit.official}` });
  }
  if (parsed.protocol === "http:") {
    flags.push({ kind: "no-https", detail: "claim page served over plain http — legit distributors use https" });
  }

  // 2. Red-flag language.
  const PHRASES = ["connect wallet to claim", "limited time", "act now", "last chance", "expires soon", "claim your reward now", "double your", "send to receive"];
  const foundPhrases = PHRASES.filter((p) => lower.includes(p));
  if (foundPhrases.length > 0) {
    flags.push({ kind: "pressure-language", detail: `page uses high-pressure phrasing: ${foundPhrases.slice(0, 3).join("; ")}` });
  }

  // 3. Contract addresses named on the page — run up to 3 through our own
  // contract screen (best effort).
  const addrHits = [...new Set([...html.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]))].slice(0, 3);
  const contractFindings = [];
  for (const a of addrHits) {
    try {
      const cc = await contractCheck.checkContract(a, "ethereum");
      const risk = cc.risk_score != null ? cc.risk_score : null;
      contractFindings.push({ address: a, risk_score: risk, verdict: cc.verdict || null });
      if (risk != null && risk >= 60) {
        flags.push({ kind: "risky-contract", detail: `contract ${shortAddr(a)} named on the page scores ${risk}/100 on our own contract screen` });
      }
    } catch {
      /* best effort */
    }
    await sleep(350);
  }

  // 4. Does the page even mention a claim/airdrop, or is it unrelated?
  const mentionsClaim = /airdrop|claim|eligib/i.test(html);
  if (!mentionsClaim) {
    flags.push({ kind: "no-claim-content", detail: "page does not mention an airdrop or claim — may be parked, unrelated, or cloaked" });
  }

  const lookalike = flags.some((f) => f.kind === "lookalike-domain");
  const riskyContract = flags.some((f) => f.kind === "risky-contract");
  let verdict, summary;
  if (lookalike && (riskyContract || foundPhrases.length > 0)) {
    verdict = "likely-drainer";
    summary = `Likely drainer: lookalike domain borrowing a real brand name${riskyContract ? " plus a high-risk contract named on the page" : ""}${foundPhrases.length ? " plus pressure language" : ""}. Do not connect a wallet here.`;
  } else if (lookalike || riskyContract || flags.length >= 3) {
    verdict = "suspicious";
    summary = `Suspicious: ${flags[0].detail}. Treat as hostile until proven otherwise — verify through the project's official channels.`;
  } else if (flags.length === 0) {
    verdict = "likely-legit";
    summary = "No red flags in the static forensics — official-looking domain, no pressure language, no risky contracts named. Still heuristic: verify the claim through official channels before connecting.";
  } else {
    verdict = "suspicious";
    summary = `Suspicious: ${flags.map((f) => f.detail).join(" ")}`.slice(0, 300);
  }

  return {
    url: u,
    final_url: finalUrl,
    domain: finalHost,
    verdict,
    flags,
    contracts_checked: contractFindings,
    summary,
    source: "static page fetch only — no javascript executed, no wallet payloads touched (no key)",
    disclaimer: DISCLAIMER,
    note: "Heavily heuristic page forensics, not a verdict on the project's legitimacy. Cloaked pages (different content for bots) can evade static review. Never connect a wallet to a page you cannot verify through official channels.",
  };
}

async function airdropVerdict(url) {
  const key = `airdrop:${(url || "").trim().toLowerCase().slice(0, 120)}`;
  return withCache(airdropCache, key, () => runAirdropVerdict(url));
}

// ====================================================================
// /deployer-history — who made this token, and what else did they make.
// ====================================================================
const deployerCache = makeCache(60 * 60 * 1000);

async function runDeployerHistory(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… token contract address (40 hex chars)");
  const ch = checkChain(chain);
  const api = BLOCKSCOUT[ch];

  const info = await getJSON(`${api}/addresses/${addr}`);
  if (!info) throw badRequest("address not found on this chain");
  const deployer = info.creator_address_hash || info.creatorAddressHash || null;
  const creationTx = info.creation_transaction_hash || info.creationTransactionHash || null;
  if (!deployer || !isAddress(deployer)) {
    return {
      chain: ch, address: addr, deployer: null, verdict: "mixed",
      summary: "Could not determine the deployer from Blockscout — the contract may predate creator indexing or use a factory pattern this lane cannot trace.",
      contracts_created: 0, contracts: [],
      source: "blockscout keyless api (no key)", disclaimer: DISCLAIMER,
      note: "Heuristic deployer forensics, not an audit.",
    };
  }

  // Collect contracts created by the deployer (first 2 tx pages, cap 50).
  const created = [];
  let nextParams = null;
  for (let page = 0; page < 2 && created.length < 50; page++) {
    const url = nextParams
      ? `${api}/addresses/${deployer}/transactions?${nextParams}`
      : `${api}/addresses/${deployer}/transactions`;
    const pg = await getJSON(url);
    if (!pg || !pg.items) break;
    for (const t of pg.items) {
      const cc = t.created_contract || t.createdContract;
      if (cc && cc.hash && isAddress(cc.hash) && cc.hash.toLowerCase() !== addr.toLowerCase()) {
        if (!created.some((c) => c.address.toLowerCase() === cc.hash.toLowerCase())) {
          created.push({ address: cc.hash, creation_tx: t.hash, created_at: t.timestamp || null });
        }
      }
    }
    nextParams = pg.next_page_params ? new URLSearchParams(pg.next_page_params).toString() : null;
    if (!nextParams) break;
  }

  // Deep-dive up to 10: verified? scam-flagged? any activity?
  const deep = [];
  for (const c of created.slice(0, 10)) {
    let sig = { verified: null, is_scam: false, tx_count: null, name: null };
    try {
      const ai = await getJSONFast(`${api}/addresses/${c.address}`);
      if (ai) {
        sig.verified = ai.is_verified === true;
        sig.is_scam = ai.is_scam === true;
        sig.tx_count = typeof ai.transactions_count === "number" ? ai.transactions_count : null;
        sig.name = ai.name || null;
      }
    } catch { /* best effort */ }
    const dead = sig.tx_count != null && sig.tx_count < 10 && sig.verified === false;
    deep.push({ ...c, ...sig, looks_dead: dead });
    await sleep(350);
  }

  const withSig = deep.filter((d) => d.tx_count != null);
  const deadCount = deep.filter((d) => d.looks_dead).length;
  const scamCount = deep.filter((d) => d.is_scam).length;
  const total = created.length;
  let verdict, summary;
  if (scamCount > 0 || (total >= 4 && withSig.length > 0 && deadCount / withSig.length >= 0.6)) {
    verdict = "serial-rugger";
    summary = `Serial-rugger pattern: this deployer launched ${total} contract(s)${scamCount ? `, ${scamCount} Blockscout-flagged as scam` : ""}${deadCount ? `, ${deadCount} look dead (no activity, unverified)` : ""}. Treat anything they deploy as guilty until proven innocent.`;
  } else if (deadCount > 0 || total >= 4) {
    verdict = "mixed";
    summary = `Mixed: deployer launched ${total} contract(s)${deadCount ? `, ${deadCount} look dead` : ""}. Not a clean one-project builder — check each project on its own merits.`;
  } else {
    verdict = "clean";
    summary = `Clean: deployer launched ${total} contract(s), no scam flags, no dead-contract pattern. Still verify the token itself — a clean deployer has rugged before.`;
  }

  return {
    chain: ch,
    address: addr,
    deployer,
    deployer_creation_tx: creationTx,
    verdict,
    contracts_created: total,
    contracts_sampled: deep.length,
    dead_looking: deadCount,
    scam_flagged: scamCount,
    contracts: deep,
    summary,
    source: "blockscout keyless api (no key)",
    disclaimer: DISCLAIMER,
    note: "Multi-hop deployer forensics with bounded depth (max 10 contracts deep-dived). 'Dead' is a proxy (low tx count + unverified), not proof of a rug. Heuristic, not an audit.",
  };
}

async function deployerHistory(address, chain) {
  const key = `deployer:${(chain || "base").toLowerCase()}:${(address || "").toLowerCase()}`;
  return withCache(deployerCache, key, () => runDeployerHistory(address, chain));
}

// ====================================================================
// /wallet-watch — has anything changed: stateful monitoring via a
// baseline the agent passes back.
// ====================================================================
const watchCache = makeCache(5 * 60 * 1000);

function canonicalState(s) {
  const approvals = (s.approvals || [])
    .map((a) => ({ token: a.token.toLowerCase(), spender: a.spender.toLowerCase(), unlimited: !!a.unlimited, priority: a.priority }))
    .sort((a, b) => (a.token + a.spender).localeCompare(b.token + b.spender));
  return {
    wallet: s.wallet.toLowerCase(),
    chain: s.chain,
    eth_balance_wei: s.eth_balance_wei,
    tx_count: s.tx_count,
    approvals,
    unlimited_count: s.unlimited_count,
    permit2_seaport_exposed: !!s.permit2_seaport_exposed,
  };
}

function baselineTokenOf(canonical) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

async function walletState(wallet, chain) {
  const api = BLOCKSCOUT[chain];
  const [info, scan, exposure] = await Promise.all([
    getJSONFast(`${api}/addresses/${wallet}`),
    scanApprovals(wallet, chain),
    permitExposure(wallet, chain),
  ]);
  return {
    wallet,
    chain,
    eth_balance_wei: (info && info.coin_balance) || "0",
    tx_count: info && typeof info.transactions_count === "number" ? info.transactions_count : null,
    approvals: scan.approvals,
    approval_counts: scan.counts,
    unlimited_count: scan.approvals.filter((a) => a.unlimited).length,
    permit2_seaport_exposed: exposure.exposed,
    revoke_priority: revokeList(scan.approvals),
  };
}

function diffStates(prev, curr) {
  const changes = [];
  const key = (a) => `${a.token.toLowerCase()}:${a.spender.toLowerCase()}`;
  const prevMap = new Map((prev.approvals || []).map((a) => [key(a), a]));
  const currMap = new Map((curr.approvals || []).map((a) => [key(a), a]));
  for (const [k, a] of currMap) {
    if (!prevMap.has(k)) {
      changes.push(`NEW approval: ${shortAddr(a.token)} → ${shortAddr(a.spender)}${a.unlimited ? " (UNLIMITED)" : ""}`);
    } else {
      const p = prevMap.get(k);
      if (!!p.unlimited !== !!a.unlimited) {
        changes.push(`CHANGED allowance: ${shortAddr(a.token)} → ${shortAddr(a.spender)} (unlimited ${p.unlimited ? "→ limited" : "→ UNLIMITED"})`);
      }
    }
  }
  for (const [k, a] of prevMap) {
    if (!currMap.has(k)) changes.push(`REMOVED approval: ${shortAddr(a.token)} → ${shortAddr(a.spender)}`);
  }
  try {
    const dBal = BigInt(curr.eth_balance_wei || "0") - BigInt(prev.eth_balance_wei || "0");
    if (dBal !== 0n) {
      const sign = dBal > 0n ? "+" : "−";
      changes.push(`Balance ${dBal > 0n ? "increased" : "decreased"} by ${sign}${(dBal < 0n ? -dBal : dBal).toString()} wei`);
    }
  } catch { /* unparseable balances */ }
  if (prev.tx_count != null && curr.tx_count != null && curr.tx_count !== prev.tx_count) {
    changes.push(`Transaction count ${prev.tx_count} → ${curr.tx_count} (${curr.tx_count - prev.tx_count} new)`);
  }
  if (!!prev.permit2_seaport_exposed !== !!curr.permit2_seaport_exposed) {
    changes.push(curr.permit2_seaport_exposed ? "NEW: wallet touched Permit2/Seaport since baseline" : "Permit2/Seaport exposure flag cleared");
  }
  return changes;
}

async function runWalletWatch(wallet, chain, prevStateB64) {
  const w = (wallet || "").trim();
  if (!isAddress(w)) throw badRequest("wallet must be a 0x… address (40 hex chars)");
  const ch = checkChain(chain);
  const state = await walletState(w, ch);
  const canonical = canonicalState(state);
  const baseline_token = baselineTokenOf(canonical);

  if (!prevStateB64) {
    const prev_state = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
    return {
      chain: ch,
      wallet: w,
      verdict: "baseline",
      baseline_token,
      prev_state,
      state: canonical,
      revoke_priority: state.revoke_priority,
      summary: `Baseline set (${baseline_token}). Next call: GET /wallet-watch?wallet=${w}&chain=${ch}&prev_state=${prev_state} — this lane reports exactly what changed.`,
      how_to_watch: "GET /wallet-watch?wallet=0x…&chain=base&prev_state=<the prev_state value from this response>",
      source: "blockscout keyless api + public rpc eth_call (no key)",
      disclaimer: DISCLAIMER,
      note: "Best-effort monitoring, not a security guarantee. Pass the previous state back to get a diff.",
    };
  }

  let prev;
  try {
    const json = Buffer.from(prevStateB64, "base64").toString("utf8");
    prev = JSON.parse(json);
  } catch {
    throw badRequest("prev_state must be base64-encoded JSON of a previous /wallet-watch state object");
  }
  if (!prev || prev.wallet !== canonical.wallet || prev.chain !== canonical.chain) {
    throw badRequest("prev_state is for a different wallet or chain — fetch a fresh baseline first");
  }
  const changes = diffStates(prev, canonical);
  const verdict = changes.length ? "changed" : "no-changes";
  const prev_state = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
  return {
    chain: ch,
    wallet: w,
    verdict,
    baseline_token,
    prev_baseline_token: baselineTokenOf(prev),
    prev_state,
    changes,
    state: canonical,
    revoke_priority: state.revoke_priority,
    summary: verdict === "no-changes"
      ? `No changes since baseline (${baseline_token}). Same approvals, same balance, same exposure.`
      : `CHANGED since baseline: ${changes.length} difference(s) — ${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`,
    source: "blockscout keyless api + public rpc eth_call (no key)",
    disclaimer: DISCLAIMER,
    note: "Best-effort monitoring, not a security guarantee. Diff is only as fresh as the last upstream poll.",
  };
}

async function walletWatch(wallet, chain, prevStateB64) {
  // Never cache diffs — the whole point is fresh comparison.
  if (prevStateB64) return runWalletWatch(wallet, chain, prevStateB64);
  const key = `watch:${(chain || "base").toLowerCase()}:${(wallet || "").toLowerCase()}`;
  return withCache(watchCache, key, () => runWalletWatch(wallet, chain, null));
}

module.exports = {
  txDryrun,
  permitScan,
  airdropVerdict,
  deployerHistory,
  walletWatch,
  SHIELD_CHAINS: ["base", "ethereum"],
};
