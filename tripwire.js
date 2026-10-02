// TrollBridge /tripwire lane — data layer.
// Watch-and-ping: an agent plants a tripwire ("watch X, ping my webhook when
// Y happens"), the bridge polls on a 15-minute cron, and the agent's webhook
// gets woken up the moment the condition trips. Nobody sells this over x402.
//
// V1 scope (kept tight):
// - watch_type: "wallet_balance" (USDC on Base) | "token_price" (USD, DexScreener top pair) | "wallet_activity" (Base tx count)
// - condition: "above" | "below", threshold: number
// - $0.05 plants one tripwire, 7-day life, fires once, then done.
// - Storage: local watches.json next to server.js. EPHEMERAL on Render
//   free-tier redeploys — a restart loses armed watches. V2 moves this to a
//   persistent store. Documented, not hidden.
// - Webhook fire: one POST, 5s timeout, result logged (host only, never the
//   full URL). Webhook URL must be https — no http, no localhost, no creds
//   in the URL. SSRF surface is one outbound POST per trigger, fire-once.
//
// This module never moves money and never logs raw caller data.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WATCH_TYPES = ["wallet_balance", "token_price", "wallet_activity"];
const CONDITIONS = ["above", "below"];
const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WATCHES = 500;
const MAX_LABEL_CHARS = 100;
const MAX_WEBHOOK_CHARS = 500;
const FETCH_TIMEOUT_MS = 8000;
const WEBHOOK_TIMEOUT_MS = 5000;

const USDC_BASE = "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913";
const BASE_RPC_URL = "https://mainnet.base.org";
const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex/tokens/";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function storePath() {
  return path.join(__dirname, "watches.json");
}

function loadWatches(sp) {
  try {
    const d = JSON.parse(fs.readFileSync(sp || storePath(), "utf8"));
    if (d && Array.isArray(d.watches)) return d;
  } catch { /* missing or corrupt → start clean */ }
  return { watches: [] };
}

function saveWatches(d, sp) {
  fs.writeFileSync(sp || storePath(), JSON.stringify(d, null, 2));
}

function isHexAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function validWebhookUrl(s) {
  if (typeof s !== "string" || !s || s.length > MAX_WEBHOOK_CHARS) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return true;
}

function checkCondition(value, condition, threshold) {
  return condition === "above" ? value > threshold : value < threshold;
}

// Signature: plantTripwire({ watch_type, target, condition, threshold, webhook_url, label? })
// Returns the watch receipt (armed). Throws 400 on bad input.
function plantTripwire(p, sp) {
  const watch_type = p.watch_type;
  const target = p.target;
  const condition = p.condition;
  const threshold = Number(p.threshold);
  const webhook_url = p.webhook_url;

  if (!WATCH_TYPES.includes(watch_type)) {
    throw badRequest("watch_type must be one of: " + WATCH_TYPES.join(", "));
  }
  if (!isHexAddress(target)) {
    throw badRequest("target must be a 0x wallet/contract address (40 hex chars)");
  }
  if (!CONDITIONS.includes(condition)) {
    throw badRequest("condition must be 'above' or 'below'");
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw badRequest("threshold must be a positive number (USDC for wallet_balance, USD for token_price, tx count for wallet_activity)");
  }
  if (!validWebhookUrl(webhook_url)) {
    throw badRequest("webhook_url must be an https URL (no http, no localhost, no credentials in URL), max 500 chars");
  }
  let label = "";
  if (p.label !== undefined && p.label !== null && p.label !== "") {
    if (typeof p.label !== "string") throw badRequest("label must be a string");
    label = p.label.slice(0, MAX_LABEL_CHARS);
  }

  const store = loadWatches(sp);
  // Prune dead weight: drop expired watches older than 30 days on every plant.
  const now = Date.now();
  store.watches = store.watches.filter((w) => now - new Date(w.expires_at).getTime() < 30 * 24 * 60 * 60 * 1000);
  if (store.watches.length >= MAX_WATCHES) {
    throw badRequest("watch list is full (500) — wait for watches to expire");
  }

  const id = "tw_" + crypto.randomBytes(6).toString("hex");
  const created = new Date(now).toISOString();
  const watch = {
    id,
    watch_type,
    target: target.toLowerCase(),
    condition,
    threshold,
    webhook_url,
    label,
    state: "armed",
    created_at: created,
    expires_at: new Date(now + WATCH_TTL_MS).toISOString(),
    last_checked: null,
    last_value: null,
    triggered_at: null,
    fires: 0,
  };
  store.watches.push(watch);
  saveWatches(store, sp);

  const units = watch_type === "wallet_balance" ? "USDC" : watch_type === "token_price" ? "USD" : "txs";
  return {
    lane: "/tripwire",
    watch_id: id,
    state: "armed",
    watch_type,
    target: watch.target,
    condition,
    threshold,
    threshold_units: units,
    label: label || undefined,
    expires_at: watch.expires_at,
    status_url: "/tripwire/status?id=" + id,
    note: "Armed for 7 days. The bridge polls every ~15 minutes; your webhook fires once when the condition trips. Watches live on this host's disk — a bridge restart loses them (v1 limitation).",
  };
}

// Signature: getWatch(id) — free status check. Throws 400/404.
function getWatch(id, sp) {
  if (!id || typeof id !== "string") throw badRequest("missing required param: id (usage: GET /tripwire/status?id=<watch_id>)");
  const store = loadWatches(sp);
  const w = store.watches.find((x) => x.id === id);
  if (!w) {
    const e = new Error("unknown watch id");
    e.statusCode = 404;
    throw e;
  }
  const { webhook_url, ...pub } = w; // webhook target stays private
  return { lane: "/tripwire", ...pub };
}

async function fetchJson(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opts, signal: ctl.signal });
    if (!resp.ok) throw new Error("upstream " + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function rpcCall(method, params) {
  const d = await fetchJson(
    BASE_RPC_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    FETCH_TIMEOUT_MS
  );
  if (d.error) throw new Error("rpc: " + (d.error.message || "unknown"));
  return d.result;
}

// Current observed value for a watch. Throws on upstream failure.
async function readValue(w) {
  if (w.watch_type === "wallet_balance") {
    // balanceOf(target) on USDC/Base
    const data = "0x70a08231" + w.target.slice(2).padStart(64, "0");
    const hex = await rpcCall("eth_call", [{ to: USDC_BASE, data }, "latest"]);
    return Number(BigInt(hex)) / 1e6;
  }
  if (w.watch_type === "wallet_activity") {
    const hex = await rpcCall("eth_getTransactionCount", [w.target, "latest"]);
    return parseInt(hex, 16);
  }
  // token_price — DexScreener top pair by liquidity
  const d = await fetchJson(DEXSCREENER_URL + w.target, {}, FETCH_TIMEOUT_MS);
  const pairs = (d && d.pairs) || [];
  if (!pairs.length) throw new Error("no DexScreener pairs for token");
  let best = pairs[0];
  for (const p of pairs) {
    if ((p.liquidity && p.liquidity.usd || 0) > (best.liquidity && best.liquidity.usd || 0)) best = p;
  }
  const px = Number(best.priceUsd);
  if (!Number.isFinite(px)) throw new Error("no USD price on DexScreener");
  return px;
}

async function fireWebhook(w) {
  const payload = {
    watch_id: w.id,
    watch_type: w.watch_type,
    target: w.target,
    observed_value: w.last_value,
    threshold: w.threshold,
    condition: w.condition,
    triggered_at: w.triggered_at,
    label: w.label || undefined,
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const resp = await fetch(w.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    // Drain a little so sockets don't pile up; ignore the body itself.
    try { await resp.text(); } catch { /* ignore */ }
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

function webhookHost(u) {
  try { return new URL(u).hostname; } catch { return "?"; }
}

// Signature: pollWatches() — internal. Evaluates every armed, unexpired
// watch, fires webhooks once on trigger, marks the expired. Returns a
// summary report. Never throws — per-watch errors are collected.
async function pollWatches(sp) {
  const store = loadWatches(sp);
  const now = Date.now();
  const report = { checked: 0, triggered: [], expired: [], errors: [], at: new Date(now).toISOString() };

  for (const w of store.watches) {
    if (w.state !== "armed") continue;
    if (now >= new Date(w.expires_at).getTime()) {
      w.state = "expired";
      report.expired.push(w.id);
      continue;
    }
    if (report.checked >= 50) break; // v1 cap: 50 evaluations per poll
    report.checked++;
    try {
      const value = await readValue(w);
      w.last_checked = new Date().toISOString();
      w.last_value = value;
      if (checkCondition(value, w.condition, w.threshold)) {
        w.state = "triggered";
        w.triggered_at = new Date().toISOString();
        w.fires = 1;
        const res = await fireWebhook(w);
        // Host only in the log — never the full webhook URL.
        console.log(`tripwire fired ${w.id} (${w.watch_type} ${w.target} = ${value}) → ${webhookHost(w.webhook_url)}: ${res.ok ? "ok " + res.status : "FAILED " + (res.error || res.status)}`);
        report.triggered.push({ id: w.id, value, webhook_ok: res.ok });
      }
    } catch (e) {
      report.errors.push({ id: w.id, error: String(e.message || e).slice(0, 140) });
    }
  }
  try {
    saveWatches(store, sp);
  } catch (e) {
    report.errors.push({ id: "-", error: "save failed: " + String(e.message || e).slice(0, 100) });
  }
  return report;
}

module.exports = { plantTripwire, getWatch, pollWatches, WATCH_TYPES, CONDITIONS };
