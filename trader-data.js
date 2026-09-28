// TrollBridge trader-intel lanes — data layer (the $0 edition).
// All sources are free public APIs / RPCs, no keys. Aggressive caching so
// we never hammer rate limits. Every function degrades gracefully: stale
// cache or a clear "unavailable" beats a fake number, always.
const fs = require("fs");
const path = require("path");
// bs58 ships ESM-wrapped in this repo's node_modules: require() yields
// { default: { decode, ... } }. Handle both shapes.
const bs58mod = require("bs58");
const bs58decode = bs58mod.decode || (bs58mod.default && bs58mod.default.decode);

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const BASE_RPC = "https://mainnet.base.org";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
// Token addresses below are already live in this repo's toll config
// (server.js manifest) — copied verbatim, never from memory.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRICES_PATH = path.join(__dirname, "prices.json");

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, signal: opts.signal });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} -> ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// ---- tiny TTL cache ----
function makeCache(ttlMs, max = 500) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) { m.delete(k); return null; }
      return e.v;
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const enrichCache = makeCache(10 * 60 * 1000);
const tokenCache = makeCache(15 * 60 * 1000);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isBaseAddress(a) { return /^0x[0-9a-fA-F]{40}$/.test(a); }
function isSolanaAddress(a) {
  if (typeof a !== "string" || a.length < 32 || a.length > 44) return false;
  try { return bs58decode(a).length === 32; } catch { return false; }
}
function normalizeNetwork(n) {
  const v = String(n || "").toLowerCase();
  if (v === "base" || v === "solana") return v;
  throw badRequest(`network must be "base" or "solana", got "${n}"`);
}

// ---- /prices: read the cached feed built by build-feed.js ----
function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(PRICES_PATH, "utf8"));
  } catch {
    return { generated_at: null, prices: [], note: "price feed not built yet — try again shortly" };
  }
}

// ---- /enrich: wallet / address intelligence ----
async function enrichBase(address) {
  const [balanceHex, code] = await Promise.all([
    rpc(BASE_RPC, "eth_getBalance", [address, "latest"]),
    rpc(BASE_RPC, "eth_getCode", [address, "latest"]),
  ]);
  const nativeEth = Number(BigInt(balanceHex)) / 1e18;
  const isContract = code && code !== "0x";
  // Watchlist balances (v1: major stablecoin only — labeled as such).
  let usdc = null;
  try {
    const data = "0x70a08231" + "000000000000000000000000" + address.slice(2).toLowerCase();
    const balHex = await rpc(BASE_RPC, "eth_call", [{ to: USDC_BASE, data }, "latest"]);
    usdc = Number(BigInt(balHex)) / 1e6;
  } catch { /* watchlist is best-effort */ }
  const riskFlags = [];
  if (isContract) riskFlags.push("contract-address (not a plain wallet)");
  if (nativeEth === 0 && usdc === 0) riskFlags.push("zero-balance on checked assets");
  return {
    network: "base",
    address,
    address_type: isContract ? "contract" : "externally-owned-account",
    native_balance_eth: nativeEth,
    watchlist_balances: [{ symbol: "USDC", token: USDC_BASE, balance: usdc }],
    watchlist_note: "v1 checks the USDC balance only — not a full token scan",
    risk_flags: riskFlags,
  };
}

async function enrichSolana(address) {
  const [lamports, acct] = await Promise.all([
    rpc(SOLANA_RPC, "getBalance", [address]).catch(() => null),
    rpc(SOLANA_RPC, "getAccountInfo", [address, { encoding: "jsonParsed" }]).catch(() => null),
  ]);
  const sol = lamports && typeof lamports.value === "number" ? lamports.value / 1e9 : null;
  const info = acct && acct.value ? acct.value : null;
  const isProgram = !!(info && info.executable);
  const owner = info ? info.owner : null;
  // USDC token accounts owned by this address.
  let usdc = null;
  try {
    const t = await rpc(SOLANA_RPC, "getTokenAccountsByOwner", [
      address, { mint: USDC_SOLANA }, { encoding: "jsonParsed" },
    ]);
    const accs = (t.value || []).map((a) => {
      const d = a.account && a.account.data && a.account.data.parsed;
      return d && d.info ? Number(d.info.tokenAmount.uiAmount || 0) : 0;
    });
    usdc = accs.reduce((s, x) => s + x, 0);
  } catch { /* best-effort */ }
  const riskFlags = [];
  if (isProgram) riskFlags.push("on-chain-program (not a plain wallet)");
  if (sol === 0 && (usdc === 0 || usdc === null)) riskFlags.push("zero-balance on checked assets");
  return {
    network: "solana",
    address,
    address_type: isProgram ? "program" : "wallet",
    owner_program: owner,
    native_balance_sol: sol,
    watchlist_balances: [{ symbol: "USDC", token: USDC_SOLANA, balance: usdc }],
    watchlist_note: "v1 checks the USDC balance only — not a full token scan",
    risk_flags: riskFlags,
  };
}

async function enrichAddress(address, network) {
  const net = normalizeNetwork(network);
  if (!address) throw badRequest('missing required query param: address');
  if (net === "base" && !isBaseAddress(address)) throw badRequest(`"${address}" is not a valid Base (EVM) address`);
  if (net === "solana" && !isSolanaAddress(address)) throw badRequest(`"${address}" is not a valid Solana address`);
  const key = `${net}:${address}`;
  const hit = enrichCache.get(key);
  if (hit) return { ...hit, cached: true };
  const out = net === "base" ? await enrichBase(address) : await enrichSolana(address);
  out.risk_note = "risk_flags are simple heuristics (balance / address-type), not a security audit";
  out.cached = false;
  enrichCache.set(key, out);
  return out;
}

// ---- /token-check: token safety scan ----
async function dexPairs(mint) {
  const d = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
  return (d && d.pairs) || [];
}

async function solanaHolderConcentration(mint) {
  try {
    const [largest, supply] = await Promise.all([
      rpc(SOLANA_RPC, "getTokenLargestAccounts", [mint]),
      rpc(SOLANA_RPC, "getTokenSupply", [mint]),
    ]);
    const total = Number(supply && supply.value ? supply.value.uiAmount : 0);
    const holders = (largest && largest.value ? largest.value : []).map((h) => ({
      address: h.address,
      amount: Number(h.uiAmount || 0),
      share_pct: total > 0 ? (Number(h.uiAmount || 0) / total) * 100 : null,
    }));
    const top1 = holders.length ? holders[0].share_pct : null;
    const top5 = holders.length
      ? holders.slice(0, 5).reduce((s, h) => s + (h.share_pct || 0), 0)
      : null;
    return { top1_pct: top1, top5_pct: top5, holders_sampled: holders.length, total_supply: total || null };
  } catch {
    return null; // RPC hiccup — scan continues without concentration data
  }
}

function scoreToken({ pair, concentration, network }) {
  let score = 100;
  const reasons = [];
  if (!pair) {
    return {
      score: 25,
      verdict: "caution",
      reasons: ["no DEX liquidity found for this mint on DexScreener — may be unlisted, brand-new, or not a tradable token"],
    };
  }
  const liq = Number(pair.liquidity && pair.liquidity.usd) || 0;
  const vol = Number(pair.volume && pair.volume.h24) || 0;
  const buys = Number(pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0;
  const sells = Number(pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0;
  const chg = Number(pair.priceChange && pair.priceChange.h24);
  if (liq < 1000) { score -= 40; reasons.push(`very thin liquidity ($${Math.round(liq).toLocaleString()}) — easy to manipulate`); }
  else if (liq < 10000) { score -= 20; reasons.push(`thin liquidity ($${Math.round(liq).toLocaleString()})`); }
  if (sells > buys * 3 && sells > 10) { score -= 15; reasons.push(`heavy sell pressure: ${sells} sells vs ${buys} buys in 24h`); }
  if (Number.isFinite(chg) && chg < -50) { score -= 15; reasons.push(`price down ${chg.toFixed(1)}% in 24h`); }
  if (network === "solana" && concentration && concentration.top1_pct != null) {
    if (concentration.top1_pct > 50) { score -= 25; reasons.push(`single holder owns ${concentration.top1_pct.toFixed(1)}% of supply — rug risk`); }
    else if (concentration.top1_pct > 20) { score -= 10; reasons.push(`top holder owns ${concentration.top1_pct.toFixed(1)}% of supply`); }
  }
  score = Math.max(0, Math.min(100, score));
  let verdict;
  if (score >= 70) { verdict = "looks reasonable"; reasons.push("on-chain heuristics pass — still do your own research"); }
  else if (score >= 40) verdict = "caution";
  else verdict = "likely rug — stay away";
  if (!reasons.length) reasons.push("no red flags in the checked heuristics");
  return { score, verdict, reasons, _liq: liq, _vol: vol, _buys: buys, _sells: sells };
}

async function checkToken(mint, network) {
  const net = normalizeNetwork(network);
  const m = mint;
  if (!m) throw badRequest('missing required query param: mint (alias: address)');
  if (net === "base" && !isBaseAddress(m)) throw badRequest(`"${m}" is not a valid Base (EVM) token address`);
  if (net === "solana" && !isSolanaAddress(m)) throw badRequest(`"${m}" is not a valid Solana mint address`);
  const key = `${net}:${m}`;
  const hit = tokenCache.get(key);
  if (hit) return { ...hit, cached: true };

  const pairs = await dexPairs(m).catch(() => null);
  if (pairs === null) {
    // DexScreener itself is unreachable — say so, don't invent.
    const out = {
      network: net, mint: m, checked_at: new Date().toISOString(), cached: false,
      verdict: "unknown", risk_score: null,
      reasons: ["price-data source unreachable right now — try again later"],
      pair: null, holder_concentration: null,
    };
    return out;
  }
  // Primary pair = deepest liquidity for this exact mint.
  let primary = null;
  for (const p of pairs) {
    if (!p.baseToken || String(p.baseToken.address).toLowerCase() !== String(m).toLowerCase()) continue;
    const liq = Number(p.liquidity && p.liquidity.usd) || 0;
    if (!primary || liq > (Number(primary.liquidity && primary.liquidity.usd) || 0)) primary = p;
  }
  const concentration = net === "solana" ? await solanaHolderConcentration(m) : null;
  const s = scoreToken({ pair: primary, concentration, network: net });
  const out = {
    network: net,
    mint: m,
    token: primary ? { symbol: primary.baseToken.symbol, name: primary.baseToken.name } : null,
    checked_at: new Date().toISOString(),
    cached: false,
    verdict: s.verdict,
    risk_score: s.score,
    reasons: s.reasons,
    pair: primary ? {
      dex: primary.dexId,
      chain: primary.chainId,
      price_usd: Number(primary.priceUsd) || null,
      price_change_24h_pct: Number(primary.priceChange && primary.priceChange.h24),
      liquidity_usd: s._liq,
      volume_24h_usd: s._vol,
      buys_24h: s._buys,
      sells_24h: s._sells,
      url: primary.url || null,
    } : null,
    holder_concentration: concentration || (net === "base"
      ? { note: "holder concentration not computed on Base in v1" }
      : { note: "holder data unavailable right now" }),
    pairs_found: pairs.length,
    disclaimer: "Heuristics only — not financial advice, not an audit. DYOR.",
  };
  tokenCache.set(key, out);
  return out;
}

module.exports = { loadPrices, enrichAddress, checkToken };
