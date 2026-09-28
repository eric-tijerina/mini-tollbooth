# TrollBridge — an AI-tool marketplace on a toll bridge

The troll under the bridge. Pay-per-call intel feeds for AI agents, priced in
USDC via the x402 protocol — plus a marketplace where developers list their own
x402-tolled tools for agents to discover and call.

## The lanes (ours)

- `GET /` — free sample: what each lane sells, open-item counts, marketplace terms.
- `GET /bounties` — every open bounty across all boards (aibtc + Taskmarket + Superteam Earn). $0.02.
- `GET /fresh` — bounties posted in the last 24h. First come, first served. $0.02.
- `GET /deadlines` — class-action / settlement claim deadlines worth real money. $0.02.
- `GET /sweepstakes` — free-to-enter sweepstakes with real prizes, verified live. $0.02.
- `GET /health` — free liveness check.

Each tolled lane returns HTTP 402 with payment instructions; retry with the
`X-Payment` header per the x402 protocol.

`feed.json` is the product. It is built at boot and refreshed every 6 hours
while the service is awake (`node build-feed.js` also runs it standalone).

## The marketplace (theirs)

- `GET /tools` — free directory of every listed third-party tool. Browsing is
  always free; you only pay a tool's own toll when you call it.
- `POST /tools/apply` — developer application. Validates your payload and
  returns a pre-filled GitHub issue URL (one click files it); the keeper
  curates listings by hand. Junk gets delisted.

Listing terms (also served live at `GET /tools`):

- First 10 third-party tools list **FREE** as founding tools.
- After that: a one-time **1 USDC** listing toll (x402, Base) activates the listing.
- Developers run their own x402 toll at their own endpoint and keep **100%** of
  per-call payments. TrollBridge never touches call revenue — it charges the
  listing toll only.
- Requirements: a live HTTPS endpoint, your own x402 toll on it, a wallet you
  control, and an honest description.

The registry lives in `data/tools.json` (seeded with our four lanes).

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
