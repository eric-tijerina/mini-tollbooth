// Mini's Tollbooth — feed builder (the chain edition).
// Aggregates open bounties from every board with a usable public API,
// derives the 24h fresh-meat lane, collects recently-paid verdicts as
// proof the boards pay, and merges the curated deadline +
// sweepstakes lanes. Run at boot and on a timer by server.js; also
// runnable standalone: node build-feed.js
// $0 cost: read-only public APIs, no keys needed (the Superteam agent-only
// lane uses the agent API key from env when present and degrades gracefully
// without it; the general Superteam Earn lane uses the public listings API).
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "feed.json");
const PRICES_OUT = path.join(__dirname, "prices.json");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const DAY = 24 * 60 * 60 * 1000;
// Stablecoin addresses for the /prices lane — copied verbatim from this
// repo's toll config (server.js manifest), never from memory.
const PRICE_TOKENS_DEX = [
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", network: "solana" },
];
const PRICE_IDS_COINGECKO = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" },
];

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

// --- Board 1: aibtc (sats bounties, public) ---
async function aibtc() {
  try {
    const d = await getJSON("https://aibtc.com/api/bounties?status=open&limit=50");
    const list = d.bounties || (Array.isArray(d) ? d : []);
    return list.map((b) => ({
      board: "aibtc",
      id: String(b.id),
      title: b.title,
      reward: b.rewardSats ? `${b.rewardSats.toLocaleString()} sats` : "see listing",
      url: `https://aibtc.com/bounties/${b.id}`,
      posted_at: b.createdAt || null,
      expires: b.expiresAt || null,
      tags: b.tags || [],
    }));
  } catch (e) {
    return [{ board: "aibtc", error: String(e.message || e) }];
  }
}

// --- Board 2: Taskmarket (USDC bounties, public) ---
async function taskmarket() {
  try {
    const d = await getJSON("https://api.taskmarket.dev/api/tasks?status=open&limit=50");
    const list = d.tasks || [];
    return list
      .filter((t) => (t.status || "open") === "open")
      .map((t) => {
        const firstLine = String(t.description || "").split("\n")[0].replace(/^#\s*/, "").slice(0, 120);
        const usdc = typeof t.reward === "number" ? t.reward / 1e6 : null;
        return {
          board: "taskmarket",
          id: String(t.id),
          ref: t.referenceCode || null,
          title: firstLine || t.referenceCode || "untitled task",
          reward: usdc != null ? `${usdc} USDC` : "see listing",
          url: `https://taskmarket.dev/tasks/${t.id}`,
          posted_at: t.createdAt || null,
          expires: t.expiryTime || null,
          tags: t.tags || [],
        };
      });
  } catch (e) {
    return [{ board: "taskmarket", error: String(e.message || e) }];
  }
}

// --- Board 3: Superteam (agent-only listings, needs agent key) ---
async function superteam() {
  const key = process.env.SUPERTEAM_API_KEY;
  if (!key) return [{ board: "superteam", error: "no SUPERTEAM_API_KEY configured" }];
  try {
    const list = await getJSON("https://superteam.fun/api/agents/listings/live", {
      Authorization: `Bearer ${key}`,
    });
    const arr = Array.isArray(list) ? list : list.listings || [];
    return arr.map((l) => ({
      board: "superteam",
      id: String(l.id || l.slug || "unknown"),
      title: l.title || l.name || "untitled listing",
      reward: l.reward || l.amount || "see listing",
      url: l.url || l.link || "https://superteam.fun",
      posted_at: l.createdAt || l.publishedAt || null,
      expires: l.deadline || l.expiresAt || null,
      tags: l.tags || [],
    }));
  } catch (e) {
    return [{ board: "superteam", error: String(e.message || e) }];
  }
}

// --- Board 4: Superteam Earn (ALL open listings, public, no key) ---
// https://superteam.fun/api/listings returns every OPEN Earn listing
// (bounties + projects) as JSON with no auth — this is the general feed,
// not just the agent-only one. Filter to genuinely live listings:
// status OPEN, winners not announced, deadline not passed.
async function superteamEarn() {
  try {
    const d = await getJSON("https://superteam.fun/api/listings");
    const list = Array.isArray(d) ? d : [];
    const now = Date.now();
    return list
      .filter((l) => {
        if (!l || typeof l !== "object") return false;
        if (String(l.status || "").toUpperCase() !== "OPEN") return false;
        if (l.isWinnersAnnounced || l.winnersAnnouncedAt) return false;
        if (l.deadline && Date.parse(l.deadline) < now) return false;
        return true;
      })
      .map((l) => {
        const tags = [String(l.type || "bounty").toLowerCase()];
        if (l.agentAccess) tags.push(String(l.agentAccess).toLowerCase().replace(/_/g, "-"));
        let reward = "see listing";
        if (typeof l.rewardAmount === "number" && l.token) {
          reward = `${l.rewardAmount.toLocaleString()} ${l.token}`;
        } else if (l.minRewardAsk != null || l.maxRewardAsk != null) {
          reward = `${l.minRewardAsk ?? "?"}-${l.maxRewardAsk ?? "?"} ${l.token || "USD"} (ask)`;
        }
        return {
          board: "superteam-earn",
          id: String(l.id || l.slug || "unknown"),
          slug: l.slug || null,
          title: l.title || "untitled listing",
          reward,
          url: l.slug ? `https://superteam.fun/earn/listing/${l.slug}/` : "https://superteam.fun",
          posted_at: l.publishedAt || l.createdAt || null,
          expires: l.deadline || null,
          tags,
        };
      });
  } catch (e) {
    return [{ board: "superteam-earn", error: String(e.message || e) }];
  }
}

// --- Board 5: verdicts — recently PAID bounties (proof the boards pay) ---
// aibtc status=paid, Taskmarket status=completed, BountyBook status=verified.
async function verdicts() {
  const out = [];
  const errors = [];
  try {
    const d = await getJSON("https://aibtc.com/api/bounties?status=paid");
    for (const b of (d.bounties || d || []).slice(0, 25)) {
      out.push({
        board: "aibtc",
        id: String(b.id),
        title: b.title,
        reward: b.rewardSats ? `${Number(b.rewardSats).toLocaleString()} sats` : "see listing",
        url: `https://aibtc.com/bounties/${b.id}`,
        paid_at: b.paidAt || null,
        proof: b.paidTxid ? `stacks tx ${b.paidTxid}` : null,
        submissions: b.submissionCount ?? null,
      });
    }
  } catch (e) { errors.push(`aibtc-paid: ${e.message || e}`); }
  try {
    const d = await getJSON("https://api.taskmarket.dev/api/tasks?status=completed&limit=25");
    for (const t of (d.tasks || [])) {
      const firstLine = String(t.description || "").split("\n")[0].replace(/^#\s*/, "").slice(0, 120);
      const usdc = typeof t.reward === "number" ? t.reward / 1e6 : null;
      out.push({
        board: "taskmarket",
        id: String(t.id),
        ref: t.referenceCode || null,
        title: firstLine || t.referenceCode || "untitled task",
        reward: usdc != null ? `${usdc} USDC` : "see listing",
        url: `https://taskmarket.dev/tasks/${t.id}`,
        paid_at: t.claimedAt || t.updatedAt || null,
        proof: t.escrowTxHash ? `escrow tx ${t.escrowTxHash}` : null,
        submissions: t.submissionCount ?? null,
      });
    }
  } catch (e) { errors.push(`taskmarket-completed: ${e.message || e}`); }
  try {
    const d = await getJSON("https://api.bountybook.ai/jobs?status=verified&page=1");
    for (const j of ((d.jobs || d.job || [])).slice(0, 15)) {
      out.push({
        board: "bountybook",
        id: String(j.id),
        title: j.title,
        reward: j.budget_usdc ? `${j.budget_usdc} USDC` : "see listing",
        url: "https://bountybook.ai",
        paid_at: null,
        proof: j.executor_address ? `verified for ${j.executor_address}` : "oracle-verified",
        submissions: null,
      });
    }
  } catch (e) { errors.push(`bountybook-verified: ${e.message || e}`); }
  out.sort((x, y) => Date.parse(y.paid_at || 0) - Date.parse(x.paid_at || 0));
  return { verdicts: out, errors };
}

function loadCurated(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}

// --- /opportunities lane: one normalized schema across every board ---
// {title, payout_amount, payout_token, payout_raw, chain, url,
//  requirements, deadline, board, posted_at}
// Built from the same open-bounty records as /bounties — no new fetches,
// no new failure modes. Boards that are down simply contribute nothing,
// same as the other lanes. Never invents: unparseable rewards keep
// payout_amount/token null with the raw string preserved; chain is only
// set when the token strongly implies it (sats -> Stacks via aibtc),
// otherwise null.
function parseReward(raw) {
  const out = { payout_amount: null, payout_token: null, payout_raw: raw || null };
  if (!raw || /see listing/i.test(String(raw))) return out;
  const s = String(raw).replace(/,/g, "");
  const m = s.match(/\$?\s*([\d.]+)(?:\s*-\s*\$?[\d.]+)?\s*([a-zA-Z$]+)?/);
  if (!m || !m[1]) return out;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return out;
  let tok = (m[2] || "").toUpperCase();
  if (!tok || tok === "$") tok = /^\s*\$/.test(s) ? "USD" : null;
  out.payout_amount = amount;
  out.payout_token = tok;
  return out;
}
function inferChain(board, payout_token) {
  // aibtc pays sBTC on Stacks — the only token->chain mapping we know
  // first-hand. Everything else stays null rather than guessed.
  if (board === "aibtc" && payout_token === "SATS") return "stacks";
  return null;
}
function buildOpportunities(bounties) {
  return (bounties || [])
    .filter((b) => b && !b.error && b.title)
    .map((b) => {
      const { payout_amount, payout_token, payout_raw } = parseReward(b.reward);
      const tags = Array.isArray(b.tags) ? b.tags : [];
      return {
        title: b.title,
        payout_amount,
        payout_token,
        payout_raw,
        chain: inferChain(b.board, payout_token),
        url: b.url || null,
        requirements: tags.filter((t) => t && !/^(bounty|project)$/i.test(String(t))),
        deadline: b.expires || null,
        board: b.board,
        posted_at: b.posted_at || null,
      };
    })
    .sort((x, y) => Date.parse(y.posted_at || 0) - Date.parse(x.posted_at || 0));
}

// --- /prices lane: agent-ready spot prices, free sources only ---
// CoinGecko (no key) for the majors + DexScreener (no key) for the watched
// DEX tokens. Runs with the feed build (every 6h). On ANY failure the old
// prices.json is left untouched — stale prices beat fake prices.
async function buildPrices() {
  const prices = [];
  const errors = [];
  try {
    const ids = PRICE_IDS_COINGECKO.map((c) => c.id).join(",");
    const d = await getJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
    );
    for (const c of PRICE_IDS_COINGECKO) {
      const row = d[c.id];
      if (row && typeof row.usd === "number") {
        prices.push({
          symbol: c.symbol,
          name: c.name,
          price_usd: row.usd,
          change_24h_pct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
          source: "coingecko",
        });
      }
    }
  } catch (e) { errors.push(`coingecko: ${e.message || e}`); }
  try {
    const addrs = PRICE_TOKENS_DEX.map((t) => t.address).join(",");
    const d = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`);
    const pairs = (d && d.pairs) || [];
    for (const t of PRICE_TOKENS_DEX) {
      const mine = pairs.filter(
        (p) => p.baseToken && String(p.baseToken.address).toLowerCase() === t.address.toLowerCase()
      );
      if (!mine.length) continue;
      mine.sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0));
      const p = mine[0];
      prices.push({
        symbol: p.baseToken.symbol,
        name: p.baseToken.name,
        network: t.network,
        token_address: t.address,
        price_usd: Number(p.priceUsd) || null,
        change_24h_pct: p.priceChange && p.priceChange.h24 != null ? Number(p.priceChange.h24) : null,
        liquidity_usd: Number(p.liquidity && p.liquidity.usd) || null,
        volume_24h_usd: Number(p.volume && p.volume.h24) || null,
        source: "dexscreener",
      });
    }
  } catch (e) { errors.push(`dexscreener: ${e.message || e}`); }
  if (!prices.length) {
    console.error(`prices build failed (${errors.join("; ")}) — keeping previous prices.json`);
    return null;
  }
  const doc = {
    generated_at: new Date().toISOString(),
    refresh: "every 6h",
    sources: "coingecko + dexscreener (free tiers, no keys)",
    prices,
    errors,
  };
  fs.writeFileSync(PRICES_OUT, JSON.stringify(doc, null, 2));
  console.log(`wrote ${PRICES_OUT}: ${prices.length} prices` + (errors.length ? ` | errors: ${errors.join("; ")}` : ""));
  return doc;
}

async function build() {
  const [a, t, s, se] = await Promise.all([aibtc(), taskmarket(), superteam(), superteamEarn()]);
  const errors = [...a, ...t, ...s, ...se].filter((b) => b.error);
  // Dedupe: same listing can appear on both Superteam boards (agent-only
  // feed vs general Earn feed). First occurrence wins, so the agent board's
  // record is kept and the Earn duplicate is dropped.
  const seen = new Set();
  const bounties = [...a, ...t, ...s, ...se].filter((b) => {
    if (b.error) return false;
    const url = String(b.url || "").toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
    const key =
      url && url !== "https://superteam.fun"
        ? "u:" + url
        : (b.slug ? "s:" + String(b.slug).toLowerCase() : `b:${b.board}:${b.id}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { verdicts: paid, errors: verdictErrors } = await verdicts();
  await buildPrices().catch((e) => console.error("prices build failed:", e.message));

  const cutoff = Date.now() - DAY;
  const fresh = bounties.filter((b) => {
    const ts = b.posted_at ? Date.parse(b.posted_at) : NaN;
    return !Number.isNaN(ts) && ts >= cutoff;
  });

  const deadlines = loadCurated("deadlines");
  const sweepstakes = loadCurated("sweepstakes");

  // Lane 15: every open bounty normalized to one schema — the product
  // version of /bounties for agents that want payouts, chains, deadlines
  // without learning five boards' formats.
  const opportunities = buildOpportunities(bounties);

  const feed = {
    generated_at: new Date().toISOString(),
    booth: "mini-tollbooth",
    lanes: {
      bounties: "GET /bounties — every open bounty across all boards",
      fresh: "GET /fresh — bounties posted in the last 24h",
      verdicts: "GET /verdicts — recently paid bounties, proof the boards pay",
      deadlines: "GET /deadlines — class-action claim deadlines worth money",
      sweepstakes: "GET /sweepstakes — free sweepstakes with real prizes",
      opportunities: "GET /opportunities — every paying opportunity, one normalized schema",
    },
    bounties,
    fresh,
    verdicts: paid,
    deadlines: deadlines ? deadlines.deadlines : [],
    sweepstakes: sweepstakes ? sweepstakes.sweepstakes : [],
    opportunities,
    count: {
      bounties: bounties.length,
      fresh: fresh.length,
      verdicts: paid.length,
      deadlines: deadlines ? deadlines.deadlines.length : 0,
      sweepstakes: sweepstakes ? sweepstakes.sweepstakes.length : 0,
      opportunities: opportunities.length,
    },
    board_errors: [...errors.map((e) => `${e.board}: ${e.error}`), ...verdictErrors],
  };
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2));
  console.log(
    `wrote ${OUT}: ${feed.count.bounties} bounties (${feed.count.fresh} fresh), ` +
      `${feed.count.verdicts} verdicts, ` +
      `${feed.count.deadlines} deadlines, ${feed.count.sweepstakes} sweepstakes, ` +
      `${feed.count.opportunities} opportunities` +
      (feed.board_errors.length ? ` | board errors: ${feed.board_errors.join("; ")}` : "")
  );
  return feed;
}

if (require.main === module) {
  build().catch((e) => { console.error("feed build failed:", e.message); process.exit(1); });
}
module.exports = { build, buildPrices, buildOpportunities, parseReward };
