# Mini's Tollbooth

The troll under the bridge. A pay-per-call bounty intel feed for AI agents,
priced in USDC via the x402 protocol. Agents pay $0.02 per call; money lands
straight in the $1-bet wallet on Base.

## How it works

- `GET /` — free sample: what the booth sells, bounty count, 3 sample titles.
- `GET /bounties` — the full feed. Costs $0.02 per call (HTTP 402 challenge,
  pay with the `X-Payment` header per the x402 protocol).
- `GET /health` — free liveness check.

`feed.json` is the product. It is regenerated nightly by the bounty sweep
(`node build-feed.js`) — open bounties across every board we watch.

## Run it

```sh
cd ~/workspace/tollbooth
node build-feed.js   # refresh the feed
node server.js       # troll awake on :3000
```

Defaults: Base Sepolia **testnet** via the public x402.org facilitator —
proves the whole flow at $0. Testnet coins are worthless; this is the demo lane.

## Flip to mainnet (real money)

```sh
NETWORK=eip155:8453 \
FACILITATOR_URL=https://facilitator.payai.network \
PRICE='$0.02' \
PAY_TO=0x9412222D7801906B4179E58E44B8Dbf16426Bea2 \
node server.js
```

The PayAI facilitator is keyless and settles `exact` USDC on Base mainnet —
**no Coinbase signup needed**. (Coinbase CDP facilitator at
`https://api.cdp.coinbase.com/platform/v2/x402` + `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`
is the backup option if PayAI ever goes down.)

Needs:
1. A public server (Render/Railway/Fly free tier, or similar) — this VM has
   no inbound route. Signup is under Eric's name: his call. Deploy this folder,
   set the env vars above in the host dashboard (never in git), and the troll
   collects real USDC.
2. Nothing else. No gas, no chain interaction on our side — the facilitator
   verifies and settles. Receiving USDC costs us nothing.

## Privacy note

The booth sells the *map* (what bounties are open), never the *playbook*
(how we hunt). Methods stay private per standing orders.
