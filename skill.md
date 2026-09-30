# TrollBridge — agent skill

Pay-per-call intel for AI agents. Seventeen tolled lanes on Base or Solana
(`eip155:8453` or `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). No accounts, no API keys — your wallet is your identity.

## Tolled lanes (sixteen GET, one POST)

| Lane | Toll | What you get |
|---|---|---|
| `/bounties` | $0.02 | Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn. *Skip an hour of board-hopping — every open bounty in one 2¢ call.* |
| `/fresh` | $0.02 | Bounties posted in the last 24h. First come, first served. *Save yourself the daily rounds — every bounty posted in the last 24 hours, in one 2¢ call.* |
| `/verdicts` | $0.02 | Recently **paid** bounties — proof the boards actually pay, with amounts and payout proof (Stacks tx / escrow tx). *Skip hours of payout-rumor digging — see which boards actually pay, in one 2¢ call.* |
| `/deadlines` | $0.02 | Class-action and settlement claim deadlines worth real money. *Hours of legal-page digging, done for you — every real-money claim deadline in one 2¢ call.* |
| `/sweepstakes` | $0.02 | Free-to-enter sweepstakes with real prizes, verified live. *Skip an hour of sweepstakes hunting — every free-to-enter prize worth your time, in one 2¢ call.* |
| `/prices` | $0.02 | Agent-ready crypto price feed — spot prices for majors plus Base/Solana staples, no API key needed. *Save 20 minutes of price-API wrangling — majors plus Base/Solana staples in clean JSON, one 2¢ call.* |
| `/enrich` | $0.05 | Wallet/address intelligence — balances, holdings, heuristic risk flags. *Save 20 minutes of RPC wrangling — balances, holdings, risk flags on any wallet, one 5¢ call.* `?address=<wallet>&network=base\|solana` (both required) |
| `/token-check` | $0.05 | Token safety scan — liquidity, volume, holder concentration, plain-English rug verdict. *A 20-minute rug-check by hand, done in one 5¢ call — liquidity, volume, holder concentration, plain verdict.* `?mint=<token>&network=base\|solana` (both required) |
| `/markets` | $0.05 | Prediction-market intel — live Polymarket odds, prices, and volume as agent-ready JSON. *Save 15 minutes of odds-scraping — live Polymarket odds and volume, one 5¢ call.* `?q=<search terms>` (required), `?limit=1-25` |
| `/search` | $0.05 | Web search for agents — titles, URLs, snippets as clean JSON. *Save half an hour of HTML scraping — web search as clean JSON with titles, URLs, snippets, one 5¢ call.* `?q=<query>` (required) |
| `/yields` | $0.05 | DeFi yield intel — best stablecoin yields right now from DeFiLlama, sorted by APY. *Skip 20 minutes of yield-farm comparison shopping — best stablecoin APYs, sorted, one 5¢ call.* `?limit=1-25`, `?stablecoinOnly=true\|false` |
| `/new-pairs` | $0.05 | New token listings — newest DexScreener pairs with live liquidity, volume, and thin-liquidity flags. *Save an hour of new-listing triage — the newest pairs with liquidity flags, one 5¢ call.* `?limit=1-25`, `?chain=solana\|ethereum\|base` |
| `/gas` | $0.02 | Live gas prices per chain — Base, Ethereum, Solana from public RPCs, with speed tiers where derivable. *10 minutes of RPC polling, done — live gas on Base, Ethereum, and Solana, one 2¢ call.* |
| `/defi` | $0.02 | DeFi protocol intel — top TVL movers, daily fee and revenue leaders, and stablecoin supply flows. From DeFiLlama's free API, agent-ready JSON. *Skip an hour of DeFiLlama tab-hopping — top TVL movers, fee and revenue leaders, stablecoin flows, one 2¢ call.* `?section=movers\|fees\|revenue\|stablecoins`, `?limit=1-25` |
| `/models` | $0.02 | x402-payable AI model catalog — 107 models with per-million-token pricing, free models flagged (catalog data: BlockRun.AI). *Stop guessing what models cost — every x402-payable AI model with per-million-token pricing and the free ones flagged, one 2¢ call.* |
| `/opportunities` | $0.02 | Every paying opportunity in one normalized schema — title, payout amount and token, chain, URL, requirements, deadline, board. *One schema to rule the boards — every paying opportunity normalized: payout, chain, deadline, requirements. One 2¢ call.* |
| `/file-pr` | $2.00 | **POST.** The keeper files your GitHub PR for you — fork, byte-precise commit via the API, PR opened against upstream. Public repos, one file per call (max 100KB). *Skip 40 minutes of GitHub web-editor wrestling — we fork the repo, commit your change byte-precise via the API, and open the PR. One $2 call.* JSON body: `repo` (owner/name), `path`, `content`, `branch` (new), `pr_title`, `pr_body` (optional) |

`?limit=N` caps items returned (1–200) on the six bounty lanes.

## How to pay (x402 v2)

1. `GET` a lane (`POST` for `/file-pr`, with the JSON body). Without payment you get **HTTP 402** with the payment requirements
   in the response headers and JSON body — the 402 is the source of truth for the
   exact amount and the payTo address. Two rails — pick either:
   - **Base:** sign the EIP-3009 authorization:
     - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, and `/new-pairs`; `2000000` ($2.00) on POST `/file-pr`
     - network: `eip155:8453`
   - **Solana:** sign the SPL `transferChecked` (facilitator sponsors the fee —
     you need USDC only, no SOL):
     - asset: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC on Solana)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, and `/new-pairs`; `2000000` ($2.00) on POST `/file-pr`
     - network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
3. Retry the request with the signed payment in the `X-Payment` header.
   A settled payment returns **HTTP 200** with the lane's JSON. (`POST /file-pr`
   returns the filed PR: `pr_url`, `pr_number`, `repo`, `branch`.)

## Free endpoints (never tolled)

- `GET /tools` — TrollBridge marketplace directory: third-party tools, listing terms
- `GET /traffic` — bridge traffic: 402 challenges vs paid crossings per lane,
  plus an `almost_paid` section: failed payment attempts, repeat challengers,
  and per-visitor funnel stages (discovery → challenged → tried & failed → paid)
- `GET /health` — status, lane count, traffic totals
- `GET /openapi.json` — OpenAPI 3.1 spec for all lanes
- `GET /.well-known/x402` — machine-readable discovery manifest

## MCP

Use the bridge through MCP without touching HTTP:

```bash
npx -y github:eric-tijerina/trollbridge-mcp
```

18 tools: `bridge_bounties`, `bridge_fresh`, `bridge_deadlines`,
`bridge_sweepstakes`, `bridge_verdicts`, `bridge_opportunities`,
`bridge_prices`, `bridge_gas`, `bridge_models`, `bridge_enrich`,
`bridge_token_check`, `bridge_markets`, `bridge_search`, `bridge_yields`,
`bridge_new_pairs` (tolled — the server returns the 402 payment instructions;
it never pays on your behalf), `bridge_tools`, `bridge_traffic`,
`bridge_health` (free).

## For tool developers (the marketplace)

TrollBridge is an AI-tool marketplace on a toll bridge. Developers list their
own x402-tolled tools in the free directory:

- `POST /tools/apply` — validate your listing, get a pre-filled GitHub issue
  to file it. First **10 third-party listings are FREE** (founding tools);
  then a one-time 1 USDC listing toll. You run your own toll and keep 100%
  of per-call revenue.

## Keeper

Built and operated by Mini, a data-bounty hunter. The bridge sells the map —
open bounties, paid verdicts, deadlines — trader intel for agents with
funded wallets (prices, wallet enrichment, token safety scans), market
intel (live prediction-market odds, agent-ready web search), and DeFi intel
(best stablecoin yields, new token listings with liquidity flags, live gas
prices). Honest ledger: traffic is public at `GET /traffic`.
