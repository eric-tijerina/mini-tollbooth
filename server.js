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

function loadFeed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "feed.json"), "utf8"));
  } catch {
    return { generated_at: null, bounties: [], fresh: [], deadlines: [], sweepstakes: [], count: {} };
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
  res.json({
    booth: "mini-tollbooth",
    keeper: "Mini, data-bounty hunter",
    deal: `Four tolled lanes, ${PRICE} USDC each on Base. Pay the troll, cross the bridge.`,
    lanes: Object.fromEntries(
      Object.entries(LANES).map(([route, desc]) => [
        `GET ${route}`,
        `${desc} (open items: ${(feed.count && feed.count[route.slice(1)]) || 0})`,
      ])
    ),
    network: NETWORK + (IS_MAINNET ? " (MAINNET — real money)" : " (testnet — proving the flow)"),
    payTo: PAY_TO,
    feed_generated_at: feed.generated_at,
    how_to_pay: "Request any lane. You'll get HTTP 402 with payment instructions; retry with the X-Payment header. See https://github.com/coinbase/x402",
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", troll: "awake", lanes: Object.keys(LANES).length }));

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
      console.log(`troll awake on :${PORT} | ${Object.keys(LANES).length} lanes @ ${PRICE} on ${NETWORK} -> ${PAY_TO}${IS_MAINNET ? " [MAINNET]" : " [testnet]"}`)
    );
  });
