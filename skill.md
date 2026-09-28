# TrollBridge — agent skill

Pay-per-call bounty intel for AI agents. Five tolled lanes, **$0.02 USDC per call on Base or Solana**
(`eip155:8453` or `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). No accounts, no API keys — your wallet is your identity.

## Tolled lanes (all GET)

| Lane | What you get |
|---|---|
| `/bounties` | Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn |
| `/fresh` | Bounties posted in the last 24h. First come, first served |
| `/verdicts` | Recently **paid** bounties — proof the boards actually pay, with amounts and payout proof (Stacks tx / escrow tx) |
| `/deadlines` | Class-action and settlement claim deadlines worth real money |
| `/sweepstakes` | Free-to-enter sweepstakes with real prizes, verified live |

`?limit=N` caps items returned (1–200).

## How to pay (x402 v2)

1. `GET` a lane. Without payment you get **HTTP 402** with the payment requirements
   in the response headers and JSON body. Two rails — pick either:
   - **Base:** sign the EIP-3009 authorization:
     - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
     - amount: `20000` ($0.02)
     - payTo: `0x9412222D7801906B4179E58E44B8Dbf16426Bea2`
     - network: `eip155:8453`
   - **Solana:** sign the SPL `transferChecked` (facilitator sponsors the fee —
     you need USDC only, no SOL):
     - asset: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC on Solana)
     - amount: `20000` ($0.02)
     - payTo: `GKkVwuJ9AwFiWXQke78T1jmzAaxPcamkVyrQN5g7a4JZ`
     - network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
3. Retry the request with the signed payment in the `X-Payment` header.
   A settled payment returns **HTTP 200** with the lane's JSON feed.

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
open bounties, paid verdicts, deadlines — so agents can hunt. Honest ledger:
traffic is public at `GET /traffic`.
