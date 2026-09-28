// Mini's Tollbooth — the troll under the bridge.
// Agents pay $0.02 USDC on Base per call for the full bounty intel feed.
// Pay-To: 0x9412222D7801906B4179E58E44B8Dbf16426Bea2 (Mini's $1-bet wallet, Base)
//
// Run: node server.js   (expects feed.json next to it; build with node build-feed.js)
// Cost to operate: $0. No gas, no chain interaction — the facilitator verifies.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const PAY_TO = process.env.PAY_TO || "0x9412222D7801906B4179E58E44B8Dbf16426Bea2";
// Network is env-configurable. Default: Base Sepolia TESTNET (free, via the
// public x402.org facilitator) so the whole flow can be proven at $0.
// Mainnet flip: NETWORK=eip155:8453 + FACILITATOR_URL=https://facilitator.payai.network
// (keyless, settles Base mainnet — no Coinbase signup needed). Coinbase CDP
// facilitator (https://api.cdp.coinbase.com/platform/v2/x402 + CDP_API_KEY_ID/SECRET)
// is the premium alternative if PayAI ever goes down.
const NETWORK = process.env.NETWORK || "eip155:84532"; // Base Sepolia testnet
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const PRICE = process.env.PRICE || "$0.02";
const PORT = process.env.PORT || 3000;
const IS_MAINNET = NETWORK === "eip155:8453";

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
    return { generated_at: null, bounties: [], count: 0, note: "feed not built yet" };
  }
}

// The toll: full feed costs $0.02 USDC on Base.
app.use(
  paymentMiddleware(
    {
      "GET /bounties": {
        accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO }],
        description: "Full curated bounty intel feed — every open bounty worth an agent's time.",
        mimeType: "application/json",
      },
    },
    server
  )
);

// Free sample: the troll lets you peek at the bridge before paying.
app.get("/", (req, res) => {
  const feed = loadFeed();
  res.json({
    booth: "mini-tollbooth",
   keeper: "Mini, data-bounty hunter",
    deal: "Pay the troll, cross the bridge. Full bounty intel feed for $0.02 USDC on Base.",
    paid_route: `GET /bounties  ->  ${PRICE} ${IS_MAINNET ? "USDC (Base mainnet)" : "test USDC (Base Sepolia testnet)"} per call, payTo ${PAY_TO}`,
    network: NETWORK + (IS_MAINNET ? " (MAINNET — real money)" : " (testnet — proving the flow)"),
    free_sample: {
      generated_at: feed.generated_at,
      open_bounty_count: feed.count,
      sample_titles: feed.bounties.filter((b) => !b.error).slice(0, 3).map((b) => b.title),
    },
    how_to_pay: "Send any request to /bounties. You'll get HTTP 402 with payment instructions; retry with the X-Payment header. See https://github.com/coinbase/x402",
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", troll: "awake" }));

app.get("/bounties", (req, res) => {
  res.json(loadFeed());
});

app.listen(PORT, () => console.log(`troll awake on :${PORT} | toll=${PRICE} on ${NETWORK} -> ${PAY_TO}${IS_MAINNET ? " [MAINNET]" : " [testnet]"}`));
