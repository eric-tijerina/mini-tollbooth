# TrollBridge — agent skill

Pay-per-call intel for AI agents. Thirteen tolled lanes on Base or Solana
(`eip155:8453` or `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). No accounts, no API keys — your wallet is your identity.

## Tolled lanes (all GET)

| Lane | Toll | What you get |
|---|---|---|
| `/bounties` | $0.02 | Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn |
| `/fresh` | $0.02 | Bounties posted in the last 24h. First come, first served |
| `/verdicts` | $0.02 | Recently **paid** bounties — proof the boards actually pay, with amounts and payout proof (Stacks tx / escrow tx) |
| `/deadlines` | $0.02 | Class-action and settlement claim deadlines worth real money |
| `/sweepstakes` | $0.02 | Free-to-enter sweepstakes with real prizes, verified live |
| `/prices` | $0.02 | Agent-ready crypto price feed — spot prices for majors plus Base/Solana staples, no API key needed |
| `/enrich` | $0.05 | Wallet/address intelligence — balances, holdings, heuristic risk flags. `?address=<wallet>&network=base\|solana` (both required) |
| `/token-check` | $0.05 | Token safety scan — liquidity, volume, holder concentration, plain-English rug verdict. `?mint=<token>&network=base\|solana` (both required) |
| `/markets` | $0.05 | Prediction-market intel — live Polymarket odds, prices, and volume as agent-ready JSON. `?q=<search terms>` (required), `?limit=1-25` |
| `/search` | $0.05 | Web search for agents — titles, URLs, snippets as clean JSON. `?q=<query>` (required) |
| `/yields` | $0.05 | DeFi yield intel — best stablecoin yields right now from DeFiLlama, sorted by APY. `?limit=1-25`, `?stablecoinOnly=true\|false` |
| `/new-pairs` | $0.05 | New token listings — newest DexScreener pairs with live liquidity, volume, and thin-liquidity flags. `?limit=1-25`, `?chain=solana\|ethereum\|base` |
| `/gas` | $0.02 | Live gas prices per chain — Base, Ethereum, Solana from public RPCs, with speed tiers where derivable |

`?limit=N` caps items returned (1–200) on the five bounty lanes.

## How to pay (x402 v2)

1. `GET` a lane. Without payment you get **HTTP 402** with the payment requirements
   in the response headers and JSON body — the 402 is the source of truth for the
   exact amount and the payTo address. Two rails — pick either:
   - **Base:** sign the EIP-3009 authorization:
     - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, and `/gas`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, and `/new-pairs`
     - network: `eip155:8453`
   - **Solana:** sign the SPL `transferChecked` (facilitator sponsors the fee —
     you need USDC only, no SOL):
     - asset: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC on Solana)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, and `/gas`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, and `/new-pairs`
     - network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
3. Retry the request with the signed payment in the `X-Payment` header.
   A settled payment returns **HTTP 200** with the lane's JSON.

## Free endpoints (never tolled)

- `GET /tools` — TrollBridge marketplace directory: third-party tools, listing terms
- `GET /traffic` — bridge traffic: 402 challenges vs paid crossings per lane
- `GET /health` — status, lane count, traffic totals
- `GET /openapi.json` — OpenAPI 3.1 spec for all lanes
- `GET /.well-known/x402` — machine-readable discovery manifest

## MCP

Use the bridge through MCP without touching HTTP:

```bash
npx -y github:eric-tijerina/trollbridge-mcp
```

8 tools: `bridge_bounties`, `bridge_fresh`, `bridge_deadlines`,
`bridge_sweepstakes`, `bridge_verdicts` (tolled — the server returns the 402
payment instructions; it never pays on your behalf), `bridge_tools`,
`bridge_traffic`, `bridge_health` (free).

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
