// Mini's Tollbooth — a chain of tollbooths on one bridge.
// Four tolled lanes, each $0.02 USDC on Base per call:
//   GET /bounties    — every open bounty across all boards (aibtc + Taskmarket + Superteam)
//   GET /fresh       — bounties posted in the last 24h
//   GET /deadlines   — class-action / settlement claim deadlines worth real money
//   GET /sweepstakes — free sweepstakes with real prizes
// Pay-To: 0x9412222D7801906B4179E58E44B8Dbf16426Bea2 (Mini's $1-bet wallet, Base)
//
// Run: node server.js  (builds feed.json at boot, refreshes every 6h)
// Cost to operate: $0. No gas, no chain interaction — the facilitator verifies.
// Traffic: the troll keeps a ledger — GET /traffic (free) shows challenged
// vs paid crossings per lane plus unique payer wallets. Counters live in
// data/usage.json (ephemeral across redeploys on free-tier hosting).
const express = require("express");
const fs = require("fs");
const path = require("path");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { build } = require("./build-feed");

const PAY_TO = process.env.PAY_TO || "0x9412222D7801906B4179E58E44B8Dbf16426Bea2";
const NETWORK = process.env.NETWORK || "eip155:8453"; // Base mainnet
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.payai.network";
const PRICE = process.env.PRICE || "$0.02";
const PORT = process.env.PORT || 3000;
const IS_MAINNET = NETWORK === "eip155:8453";
const REFRESH_MS = 6 * 60 * 60 * 1000; // rebuild the feed every 6h while awake

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

const app = express();
// Required behind Render/Railway/Fly proxies: without this the middleware
// reports http:// URLs and facilitators reject the route metadata.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

// ---- Bridge traffic ledger ----
// Counts every agent that approaches the bridge: 402 challenges (lookers)
// vs paid crossings (agents through), plus unique payer wallets per lane.
// Runs BEFORE the toll collector so it sees both outcomes via res 'finish'.
// Persisted to data/usage.json (ephemeral on free-tier redeploys; the
// counters are a dashboard, not money — the chain is the money record).
const USAGE_PATH = path.join(__dirname, "data", "usage.json");
function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  } catch {
    return { bridge: "TrollBridge", started_at: new Date().toISOString(), lanes: {} };
  }
}
function laneStats(u, route) {
  if (!u.lanes[route]) {
    u.lanes[route] = { challenged: 0, paid: 0, visits: 0, payers: [], first_seen: null, last_seen: null };
  }
  return u.lanes[route];
}
let usage = loadUsage();
let usageDirty = false;
setInterval(() => {
  if (!usageDirty) return;
  try {
    fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
    usageDirty = false;
  } catch { /* best-effort */ }
}, 30000);
process.on("SIGTERM", () => {
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2)); } catch { /* best-effort */ }
});
function payerFromHeader(req) {
  try {
    const h = req.headers["x-payment"];
    if (!h) return null;
    const json = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return json?.payload?.authorization?.from || null;
  } catch {
    return null;
  }
}
app.use((req, res, next) => {
  if (!TRACKED_ROUTES[req.path]) return next();
  res.on("finish", () => {
    const st = laneStats(usage, req.path);
    const now = new Date().toISOString();
    if (!st.first_seen) st.first_seen = now;
    st.last_seen = now;
    if (res.statusCode === 402) {
      st.challenged += 1;
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      if (LANES[req.path]) {
        st.paid += 1; // past the toll collector on a tolled lane = paid crossing
        const payer = payerFromHeader(req);
        if (payer && !st.payers.includes(payer)) st.payers.push(payer);
      } else {
        st.visits += 1; // free routes: /tools directory browses
      }
    }
    usageDirty = true;
  });
  next();
});

function loadFeed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "feed.json"), "utf8"));
  } catch {
    return { generated_at: null, bounties: [], fresh: [], deadlines: [], sweepstakes: [], count: {} };
  }
}

// TrollBridge marketplace registry: third-party tools listed on the bridge.
// Curated by the keeper; developers apply via POST /tools/apply.
function loadTools() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "tools.json"), "utf8"));
  } catch {
    return { marketplace: "TrollBridge", updated_at: null, listing_terms: {}, tools: [] };
  }
}

// The tolls: every lane costs $0.02 USDC on Base.
const LANES = {
  "/bounties": "Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn.",
  "/fresh": "Bounties posted in the last 24h. First come, first served.",
  "/deadlines": "Class-action and settlement claim deadlines worth real money.",
  "/sweepstakes": "Free-to-enter sweepstakes with real prizes, verified live.",
};
const tollConfig = {};
for (const route of Object.keys(LANES)) {
  tollConfig[`GET ${route}`] = {
    accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO }],
    description: LANES[route],
    mimeType: "application/json",
  };
}
app.use(paymentMiddleware(tollConfig, server));

// Routes the traffic ledger watches: the tolled lanes plus the free directory.
const TRACKED_ROUTES = { ...LANES, "/tools": "Free directory of third-party tools on the bridge." };

// Free sample: the troll lets you peek at the bridge before paying.
app.get("/", (req, res) => {
  const feed = loadFeed();
  const registry = loadTools();
  const liveTools = registry.tools.filter((t) => t.status === "live");
  res.json({
    bridge: "TrollBridge",
    keeper: "Mini, data-bounty hunter",
    deal: `An AI-tool marketplace on a toll bridge. Four tolled bounty-intel lanes, ${PRICE} USDC each on Base — plus a directory of third-party tools. Pay the troll, cross the bridge.`,
    lanes: Object.fromEntries(
      Object.entries(LANES).map(([route, desc]) => [
        `GET ${route}`,
        `${desc} (open items: ${(feed.count && feed.count[route.slice(1)]) || 0})`,
      ])
    ),
    marketplace: {
      tools_live: liveTools.length,
      browse_free: "GET /tools — the directory is always free. You only pay a tool's own toll when you call it.",
      list_yours: "POST /tools/apply — developers list their x402-tolled tools here. First 10 third-party listings are FREE (founding tools).",
      terms: registry.listing_terms,
    },
    network: NETWORK + (IS_MAINNET ? " (MAINNET — real money)" : " (testnet — proving the flow)"),
    payTo: PAY_TO,
    feed_generated_at: feed.generated_at,
    how_to_pay: "Request any lane. You'll get HTTP 402 with payment instructions; retry with the X-Payment header. See https://github.com/coinbase/x402",
  });
});

function trafficSummary() {
  const lanes = {};
  let totalChallenged = 0, totalPaid = 0, totalVisits = 0;
  const allPayers = new Set();
  for (const [route, st] of Object.entries(usage.lanes)) {
    lanes[route] = {
      challenged: st.challenged,
      paid: st.paid,
      visits: st.visits || 0,
      unique_payers: st.payers.length,
      first_seen: st.first_seen,
      last_seen: st.last_seen,
    };
    totalChallenged += st.challenged;
    totalPaid += st.paid;
    totalVisits += st.visits || 0;
    st.payers.forEach((p) => allPayers.add(p));
  }
  return {
    since: usage.started_at,
    totals: {
      challenged: totalChallenged,
      paid_crossings: totalPaid,
      directory_visits: totalVisits,
      unique_payers: allPayers.size,
    },
    lanes,
  };
}

app.get("/health", (req, res) => {
  const registry = loadTools();
  res.json({
    status: "ok",
    troll: "awake",
    lanes: Object.keys(LANES).length,
    marketplace: "TrollBridge",
    tools_listed: registry.tools.filter((t) => t.status === "live").length,
    traffic: trafficSummary().totals,
  });
});

// The troll's own dashboard: who came to the bridge, who paid to cross.
// Free to read — counters only, no secrets. Payer addresses are public
// on-chain data; the chain itself is the money record.
app.get("/traffic", (req, res) => {
  const full = trafficSummary();
  full.payers = Object.fromEntries(
    Object.entries(usage.lanes).map(([route, st]) => [route, st.payers])
  );
  res.json(full);
});

// ---- TrollBridge marketplace: free directory, paid listings ----

// The directory is always free — you toll the crossing, not the map.
app.get("/tools", (req, res) => {
  const registry = loadTools();
  res.json({
    marketplace: "TrollBridge",
    updated_at: registry.updated_at,
    listing_terms: registry.listing_terms,
    tools: registry.tools,
  });
});

// Developer application intake. Validates the payload and returns a
// pre-filled GitHub issue URL — one click files the application durably,
// since the bridge keeps no database (the keeper curates listings by hand).
app.post("/tools/apply", (req, res) => {
  const b = req.body || {};
  const required = ["name", "developer", "description", "endpoint", "price", "pay_to"];
  const missing = required.filter((k) => typeof b[k] !== "string" || !b[k].trim());
  if (missing.length) {
    return res.status(400).json({
      status: "rejected",
      reason: `missing fields: ${missing.join(", ")}`,
      required,
      example: {
        name: "My Tool",
        developer: "your-handle",
        description: "What it does, in one honest sentence.",
        endpoint: "https://your-tool.example.com/call",
        method: "GET (optional, default GET)",
        price: "$0.05 (your own x402 toll, USDC on Base)",
        pay_to: "0xYourWallet...",
        category: "data (optional)",
        contact: "where to reach you (optional)",
      },
    });
  }
  let endpointOk = false;
  try {
    const u = new URL(b.endpoint);
    endpointOk = u.protocol === "https:";
  } catch { /* invalid */ }
  if (!endpointOk) {
    return res.status(400).json({ status: "rejected", reason: "endpoint must be a valid https:// URL" });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(b.pay_to.trim())) {
    return res.status(400).json({ status: "rejected", reason: "pay_to must be a valid EVM wallet address (0x + 40 hex chars)" });
  }
  const appId = `tb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const issueTitle = `[tool-listing] ${b.name} by ${b.developer}`;
  const issueBody = [
    `Application: ${appId}`,
    ``,
    `**Tool:** ${b.name}`,
    `**Developer:** ${b.developer}`,
    `**Description:** ${b.description}`,
    `**Endpoint:** ${b.endpoint}`,
    `**Method:** ${(b.method || "GET").toUpperCase()}`,
    `**Price:** ${b.price}`,
    `**Pay to:** ${b.pay_to}`,
    `**Category:** ${b.category || "general"}`,
    `**Contact:** ${b.contact || "n/a"}`,
  ].join("\n");
  const issueUrl =
    "https://github.com/eric-tijerina/mini-tollbooth/issues/new?title=" +
    encodeURIComponent(issueTitle) +
    "&body=" +
    encodeURIComponent(issueBody);
  // Best-effort local log for the keeper (ephemeral on free-tier hosting;
  // the GitHub issue is the durable record).
  try {
    fs.appendFileSync(
      path.join(__dirname, "data", "applications.jsonl"),
      JSON.stringify({ application_id: appId, received_at: new Date().toISOString(), ...b }) + "\n"
    );
  } catch { /* log is best-effort */ }
  res.json({
    status: "received",
    application_id: appId,
    next_step: "Open the issue URL below to file your application — one click, pre-filled. The keeper reviews every application; junk gets delisted.",
    issue_url: issueUrl,
    listing_terms: loadTools().listing_terms,
  });
});

function lane(route, key) {
  app.get(route, (req, res) => {
    const feed = loadFeed();
    res.json({
      generated_at: feed.generated_at,
      lane: route,
      description: LANES[route],
      count: (feed.count && feed.count[key]) || 0,
      items: feed[key] || [],
      board_errors: feed.board_errors || [],
    });
  });
}
lane("/bounties", "bounties");
lane("/fresh", "fresh");
lane("/deadlines", "deadlines");
lane("/sweepstakes", "sweepstakes");

// Build at boot, then keep the feed fresh while awake.
build()
  .catch((e) => console.error("boot feed build failed:", e.message))
  .finally(() => {
    setInterval(() => build().catch((e) => console.error("refresh failed:", e.message)), REFRESH_MS);
    app.listen(PORT, () =>
      console.log(`troll awake on :${PORT} | TrollBridge: ${Object.keys(LANES).length} lanes @ ${PRICE} on ${NETWORK} -> ${PAY_TO}${IS_MAINNET ? " [MAINNET]" : " [testnet]"} | tools: ${loadTools().tools.filter((t) => t.status === "live").length} listed`)
    );
  });
