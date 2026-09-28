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

app.get("/health", (req, res) => {
  const registry = loadTools();
  res.json({
    status: "ok",
    troll: "awake",
    lanes: Object.keys(LANES).length,
    marketplace: "TrollBridge",
    tools_listed: registry.tools.filter((t) => t.status === "live").length,
  });
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
