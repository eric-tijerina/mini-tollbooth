// TrollBridge /wallet-check lane — data layer (the $0 edition).
// Wallet dossier ($0.05): Blockscout's free keyless API — wallet age (first
// on-chain transaction), transaction count, native balance, funding source
// (who sent the first inbound transfer), plus simple bot-likelihood
// heuristics (age vs activity, funding pattern). The $0.05 /enrich lane does
// balances and holdings; this lane answers "how old, how busy, who funded
// it, does it look like a bot."
//
// HEURISTIC DOSSIER, NOT A VERDICT ON INTENT: these are pattern matches
// against public data. A fresh, busy wallet is not proof of botting, and an
// old quiet wallet is not proof of trustworthiness.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const BLOCKSCOUT_V2 = {
  base: "https://base.blockscout.com/api/v2",
  ethereum: "https://eth.blockscout.com/api/v2",
};
const BLOCKSCOUT_V1 = {
  base: "https://base.blockscout.com/api",
  ethereum: "https://eth.blockscout.com/api",
};
const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};

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

async function hasCode(chain, addr, timeoutMs = 12000) {
  for (const rpc of EVM_RPCS[chain]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.result && j.result !== "0x" && j.result.length > 2) return true;
      return false;
    } catch {
      // try next RPC
    }
  }
  return null; // unknown
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
const walletCache = makeCache(30 * 60 * 1000);

async function walletCheck(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… wallet address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!BLOCKSCOUT_V2[ch]) throw badRequest("chain must be base or ethereum");
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = walletCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  let out;
  try {
    out = await runWalletCheck(addr, ch);
  } catch (e) {
    if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
    throw e;
  }
  out = { generated_at: new Date().toISOString(), cached: false, ...out };
  walletCache.set(key, out);
  return out;
}

async function runWalletCheck(addr, chain) {
  const v2 = BLOCKSCOUT_V2[chain];
  const info = await getJSON(`${v2}/addresses/${addr.toLowerCase()}`);
  if (!info) throw badRequest("address not found on this chain — check the address and chain");

  // Transaction count: Blockscout's /counters endpoint is stale on this
  // instance (returns 0 for active wallets), so page the tx list instead —
  // 50 per page, up to 4 pages; more than that is reported as a lower bound.
  let txCount = 0;
  let txCountExact = true;
  try {
    let params = null;
    for (let page = 0; page < 4; page++) {
      const qs = params
        ? `?${new URLSearchParams({ block_number: String(params.block_number), index: String(params.index), items_count: "50" })}`
        : "";
      const list = await getJSON(`${v2}/addresses/${addr.toLowerCase()}/transactions${qs}`);
      const items = (list && list.items) || [];
      txCount += items.length;
      if (list && list.next_page_params) {
        params = list.next_page_params;
      } else {
        params = null;
        break;
      }
    }
    if (params) txCountExact = false;
  } catch { /* count is a bonus */ }
  const tokenTransfers = null;
  let nativeBalance = null;
  try {
    const raw = info.coin_balance;
    if (raw !== undefined && raw !== null) nativeBalance = Number(BigInt(raw)) / 1e18;
  } catch { /* balance is a bonus */ }

  // First transaction ever: Blockscout v1 txlist with sort=asc (oldest first).
  // Funding source: the sender of the first INBOUND transfer to this wallet
  // (skips the wallet's own contract creations / outbound txs).
  let firstTx = null;
  let ageDays = null;
  let funder = null;
  try {
    const v1 = `${BLOCKSCOUT_V1[chain]}?module=account&action=txlist&address=${addr.toLowerCase()}&sort=asc&page=1&offset=5`;
    const list = await getJSON(v1);
    const items = (list && list.result) || [];
    if (items.length) {
      const t0 = items[0];
      firstTx = {
        hash: t0.hash || null,
        timestamp: t0.timeStamp ? new Date(Number(t0.timeStamp) * 1000).toISOString() : null,
        from: t0.from || null,
        to: t0.to || null,
        value_eth: t0.value ? Number(BigInt(t0.value)) / 1e18 : null,
      };
      if (firstTx.timestamp) ageDays = Math.max(0, (Date.now() - Date.parse(firstTx.timestamp)) / 86400000);
      const inbound = items.find(
        (t) => t.to && t.to.toLowerCase() === addr.toLowerCase() && t.from && t.from.toLowerCase() !== addr.toLowerCase()
      );
      if (inbound) {
        funder = {
          address: inbound.from,
          first_seen: inbound.timeStamp ? new Date(Number(inbound.timeStamp) * 1000).toISOString() : null,
        };
        const code = await hasCode(chain, inbound.from);
        funder.is_contract = code;
        if (code === true) funder.note = "First funding came from a contract — faucet, dispenser, or factory pattern.";
        else if (code === false) funder.note = "First funding came from a regular wallet.";
      }
    }
  } catch { /* first-tx is a bonus */ }

  // ---- bot-likelihood heuristics ----
  const reasons = [];
  let level = "low";
  const raise = (l, reason) => {
    reasons.push(reason);
    if (l === "high") level = "high";
    else if (l === "medium" && level === "low") level = "medium";
  };
  if (txCount !== null && ageDays !== null && ageDays >= 0) {
    const perDay = txCount / Math.max(ageDays, 1 / 24);
    if (perDay > 200) raise("high", `Extreme velocity: ~${Math.round(perDay)} tx/day over ${ageDays < 1 ? "<1" : Math.round(ageDays)} day(s) — bot or scripted pattern.`);
    else if (perDay > 20) raise("medium", `High velocity: ~${Math.round(perDay)} tx/day — faster than typical human use.`);
    if (ageDays < 7 && txCount > 50) raise("high", `Brand-new wallet (${ageDays < 1 ? "<1" : ageDays.toFixed(1)} days old) with ${txCount} transactions — classic fresh-bot shape.`);
    else if (ageDays < 30 && txCount > 200) raise("medium", `Young wallet (${Math.round(ageDays)} days) with heavy activity (${txCount} txs).`);
  }
  if (txCount === 0 && txCountExact) {
    reasons.push("No on-chain transactions from this wallet — it has only ever signed off-chain authorizations (or never transacted).");
  }
  if (nativeBalance === 0) {
    raise("medium", "Zero native balance — cannot pay gas without fresh funding.");
  }
  if (!reasons.length) reasons.push("No bot-like patterns in the available signals.");

  const summary =
    level === "low"
      ? `Wallet dossier: ${txCount !== null ? `${txCount} txs` : "tx count unknown"}${ageDays !== null ? `, first seen ${ageDays < 1 ? "today" : Math.round(ageDays) + " days ago"}` : ""}${funder ? `, first funded by ${funder.address.slice(0, 10)}…` : ""}. No strong bot signals. Heuristic dossier, not a verdict on intent.`
      : `Bot-likelihood ${level.toUpperCase()}: ${reasons[0]} Heuristic dossier, not a verdict on intent.`;

  return {
    lane: "/wallet-check",
    chain,
    address: addr,
    address_type: info.is_contract ? "contract" : "externally-owned-account",
    native_balance_eth: nativeBalance,
    transaction_count: txCountExact ? txCount : `${txCount}+`,
    transaction_count_exact: txCountExact,
    token_transfers_count: tokenTransfers,
    first_transaction: firstTx,
    age_days: ageDays !== null ? +ageDays.toFixed(2) : null,
    funding_source: funder,
    bot_likelihood: level,
    bot_reasons: reasons,
    summary,
    source: "blockscout keyless api (no key)",
    disclaimer: "Heuristic dossier, not a verdict on intent: pattern matches against public chain data. A fresh, busy wallet is not proof of botting.",
    note: "Refresh: 30-min cache.",
  };
}

module.exports = { walletCheck, WALLET_CHECK_CHAINS: Object.keys(BLOCKSCOUT_V2) };
