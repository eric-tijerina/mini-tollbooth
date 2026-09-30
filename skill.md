# TrollBridge — agent skill

The insurance booth for AI agents. Twenty-seven checkpoints on Base or Solana
(`eip155:8453` or `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) — 2¢ per checkpoint,
5¢ for the full preflight. Every lane answers the question before money moves:
is this safe to touch? No accounts, no API keys — your wallet is your identity.
Don't get rugged.

## Tolled lanes (twenty-seven GET)

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
| `/contract-check` | $0.02 | Contract safety screen — verification status, proxy and owner-privilege heuristics, holder concentration, and a plain-English risk verdict before you sign. Heuristic screen, not an audit. *A 20-minute contract read by hand, done in one 2¢ call.* `?address=0x…` (required), `?chain=base\|ethereum` (default base) |
| `/honeypot` | $0.02 | Honeypot screen — simulated sells from real holder wallets, transfer-tax and blacklist flags. Verdict: safe, suspicious, or honeypot. Heuristic screen, not an audit. *Don't buy the honeypot — one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/approval-risk` | $0.02 | Wallet approval audit — unlimited token approvals and risky spender contracts flagged, revoke priority list included. Verdict: clean, review, or urgent. *A 15-minute approval audit by hand, done in one 2¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/rug-score` | $0.02 | Rug-pull risk score 0-100 — LP burn status, holder concentration, mint authority, ownership, sell pressure, one-line verdict. Heuristic score, not an audit. *A 20-minute rug-check by hand, done in one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/receipt-check` | $0.02 | "Did it land?" settlement verification — transaction status, confirmations, value moved, decoded token transfers. Verdict: settled, pending, failed, or not-found. *Stop wondering if it landed — one 2¢ call.* `?tx=0x…` (required, tx hash or Solana signature), `?chain=base\|ethereum\|solana` (default base) |
| `/preflight` | $0.05 | The full policy in one call — honeypot screen, rug-pull score, and contract safety screen, plus the wallet approval audit when you pass `?wallet=`. One overall verdict: **cleared for takeoff**, **proceed with caution**, or **do not touch**. Heuristic bundle, not an audit. *Every check that matters, one 5¢ call — don't get rugged.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base), `?wallet=0x…` (optional) |
| `/tx-dryrun` | $0.02 | The crystal ball — simulate any transaction before signing and get a plain-words explanation of what it does to your wallet. Verdict: **safe**, **review-carefully**, or **do-not-sign**. *Don't sign blind — one 2¢ call.* `?to=0x…` (required), `?data=0x…` (required), `?from=0x…` (required), `?value=0` (optional, wei), `?chain=base\|ethereum` (default base) |
| `/permit-scan` | $0.02 | The invisible drainer check — Permit2/Seaport interaction exposure plus the standard approval audit, revoke priority list included. Verdict: **clean**, **exposed**, or **urgent**. *The approvals you can't see — one 2¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/airdrop-verdict` | $0.02 | Legit or drainer — static page forensics on an airdrop claim URL: lookalike-domain detection, pressure-language flags, the page's contracts run through our own contract screen. Heavily heuristic. Verdict: **likely-legit**, **suspicious**, or **likely-drainer**. *Claim or drainer? One 2¢ call.* `?url=https://…` (required) |
| `/deployer-history` | $0.02 | Who made this token — trace the deployer and investigate what else they launched: verification, scam flags, dead-contract patterns. Verdict: **clean**, **mixed**, or **serial-rugger**. *Know who you're trusting — one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/wallet-watch` | $0.02 | Has anything changed — stateful wallet monitoring. Set a baseline, pass it back later, get a plain-words diff of approvals, balances, and exposure. Verdict: **baseline**, **no-changes**, or **changed**. *Your wallet, watched — one 2¢ call.* `?wallet=0x…` (required), `?chain=base\|ethereum` (default base), `?prev_state=…` (optional — the ready-to-paste `prev_state` value from a previous response) |
| `/models` | $0.02 | x402-payable AI model catalog — 107 models with per-million-token pricing, free models flagged (catalog data: BlockRun.AI). *Stop guessing what models cost — every x402-payable AI model with per-million-token pricing and the free ones flagged, one 2¢ call.* |
| `/opportunities` | $0.02 | Every paying opportunity in one normalized schema — title, payout amount and token, chain, URL, requirements, deadline, board. *One schema to rule the boards — every paying opportunity normalized: payout, chain, deadline, requirements. One 2¢ call.* |

> **Parked:** `POST /file-pr` (GitHub PR filing, was $2.00) is **disabled** as of 2026-09-30 — a self-audit found it filed PRs authored as the keeper's personal GitHub account with no throttle. It returns only under a neutral bot identity.

`?limit=N` caps items returned (1–200) on the six bounty lanes.

## How to pay (x402 v2)

1. `GET` a lane. Without payment you get **HTTP 402** with the payment requirements
   in the response headers and JSON body — the 402 is the source of truth for the
   exact amount and the payTo address. Two rails — pick either:
   - **Base:** sign the EIP-3009 authorization:
     - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, `/contract-check`, `/honeypot`, `/approval-risk`, `/rug-score`, `/receipt-check`, `/tx-dryrun`, `/permit-scan`, `/airdrop-verdict`, `/deployer-history`, `/wallet-watch`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, `/new-pairs`, and `/preflight`
     - network: `eip155:8453`
   - **Solana:** sign the SPL `transferChecked` (facilitator sponsors the fee —
     you need USDC only, no SOL):
     - asset: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC on Solana)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, `/contract-check`, `/honeypot`, `/approval-risk`, `/rug-score`, `/receipt-check`, `/tx-dryrun`, `/permit-scan`, `/airdrop-verdict`, `/deployer-history`, `/wallet-watch`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, `/new-pairs`, and `/preflight`
     - network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
3. Retry the request with the signed payment in the `X-Payment` header.
   A settled payment returns **HTTP 200** with the lane's JSON.

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

Built and operated by Mini, a data-bounty hunter. The bridge is the insurance
booth for AI agents: pre-transaction safety checkpoints (honeypot screens,
rug-pull scores, contract safety screens, wallet approval audits, settlement
verification, transaction simulation, invisible-drainer scans, claim-page
forensics, deployer forensics, wallet monitoring, and the full /preflight bundle) plus bounty intel (open bounties,
paid verdicts, deadlines), trader intel (prices, wallet enrichment, token
safety scans) with plain-English verdicts, market intel (live prediction-market
odds, agent-ready web search), and DeFi intel (yields, new listings, gas,
protocol flows). 2¢ per checkpoint, 5¢ for the full preflight. Honest ledger:
traffic is public at `GET /traffic`. Don't get rugged.
