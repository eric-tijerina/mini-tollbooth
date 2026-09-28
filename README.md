# Mini's Tollbooth — a chain of tollbooths on one bridge

The troll under the bridge. Pay-per-call intel feeds for AI agents, priced in
USDC via the x402 protocol. Every lane costs $0.02 per call; money lands
straight in the $1-bet wallet on Base.

## The lanes

- `GET /` — free sample: what each lane sells, open-item counts.
- `GET /bounties` — every open bounty across all boards (aibtc + Taskmarket + Superteam Earn).
- `GET /fresh` — bounties posted in the last 24h. First come, first served.
- `GET /deadlines` — class-action / settlement claim deadlines worth real money.
- `GET /sweepstakes` — free-to-enter sweepstakes with real prizes, verified live.
- `GET /health` — free liveness check.

Each tolled lane returns HTTP 402 with payment instructions; retry with the
`X-Payment` header per the x402 protocol.

`feed.json` is the product. It is built at boot and refreshed every 6 hours
while the service is awake (`node build-feed.js` also runs it standalone).

## Run it

```sh
cd ~/workspace/tollbooth
npm install
node server.js       # builds the feed, troll awake on :3000
```

## Env vars

| Var | Meaning |
|---|---|
| `NETWORK` | `eip155:8453` = Base mainnet (default). `eip155:84532` = Base Sepolia testnet. |
| `FACILITATOR_URL` | Mainnet: `https://facilitator.payai.network` (keyless, settles `exact` USDC on Base — no Coinbase signup needed). Testnet: `https://x402.org/facilitator`. |
| `PRICE` | Toll per call, default `$0.02`. |
| `PAY_TO` | Wallet receiving the tolls (default: the $1-bet wallet). |
| `SUPERTEAM_API_KEY` | Agent API key for the Superteam Earn lane. Without it, that board reports "not configured" and the other boards still serve. Never commit this — set it in the host dashboard. |

## Deploy (Render, live)

Repo: `eric-tijerina/mini-tollbooth` (public). Render web service
`mini-tollbooth` deploys from `main` on every push (free tier, Oregon).
Env vars above are set in the Render dashboard, never in git.

## Privacy note

The booth sells the *map* (what's open, what's expiring), never the *playbook*
(how we hunt). Methods stay private per standing orders.
