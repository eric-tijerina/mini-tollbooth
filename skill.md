# TrollBridge — agent skill

The insurance booth for AI agents, with Mini's Agent Supply Store on the side
of the road. Fifty-two checkpoints on Base or Solana
(`eip155:8453` or `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) — 2¢ per checkpoint,
5¢ for the value tier, 10¢ for the protection-tier lanes
(/contract-check, /approval-screen, /tx-plain-english, /honeypot-check, /tx-simulate, /skill-scan, /verdict).
Every lane answers the question before money moves: is this safe to touch? No
accounts, no API keys — your wallet is your identity. Don't get rugged.

## Tolled lanes (fifty-six GET)

| Lane | Toll | What you get |
|---|---|---|
| `/bounties` | $0.02 | Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn. *Skip an hour of board-hopping — every open bounty in one 2¢ call.* |
| `/fresh` | $0.02 | Bounties posted in the last 24h. First come, first served. *Save yourself the daily rounds — every bounty posted in the last 24 hours, in one 2¢ call.* |
| `/verdicts` | $0.02 | Recently **paid** bounties — proof the boards actually pay, with amounts and payout proof (Stacks tx / escrow tx). *Skip hours of payout-rumor digging — see which boards actually pay, in one 2¢ call.* |
| `/deadlines` | $0.02 | Class-action and settlement claim deadlines worth real money. *Hours of legal-page digging, done for you — every real-money claim deadline in one 2¢ call.* |
| `/sweepstakes` | $0.02 | Free-to-enter sweepstakes with real prizes, verified live. *Skip an hour of sweepstakes hunting — every free-to-enter prize worth your time, in one 2¢ call.* |
| `/opportunities` | $0.02 | Every paying opportunity in one normalized schema — title, payout amount and token, chain, URL, requirements, deadline, board. *One schema to rule the boards — every paying opportunity normalized: payout, chain, deadline, requirements. One 2¢ call.* |
| `/prices` | $0.02 | Agent-ready crypto price feed — spot prices for majors plus Base/Solana staples, no API key needed. *Save 20 minutes of price-API wrangling — majors plus Base/Solana staples in clean JSON with a momentum verdict, one 2¢ call.* |
| `/enrich` | $0.05 | Wallet/address intelligence — balances, holdings, heuristic risk flags. *Save 20 minutes of RPC wrangling — balances, holdings, risk flags on any wallet, one 5¢ call.* `?address=<wallet>&network=base\|solana` (both required) |
| `/token-check` | $0.05 | Token safety scan — liquidity, volume, holder concentration, plain-English rug verdict. *A 20-minute rug-check by hand, done in one 5¢ call — liquidity, volume, holder concentration, plain verdict.* `?mint=<token>&network=base\|solana` (both required) |
| `/markets` | $0.05 | Prediction-market intel — live Polymarket odds, prices, and volume as agent-ready JSON. *Save 15 minutes of odds-scraping — live Polymarket odds and volume, one 5¢ call.* `?q=<search terms>` (required), `?limit=1-25` |
| `/search` | $0.05 | Web search for agents — titles, URLs, snippets as clean JSON. *Save half an hour of HTML scraping — web search as clean JSON with titles, URLs, snippets, one 5¢ call.* `?q=<query>` (required) |
| `/yields` | $0.05 | DeFi yield intel — best stablecoin yields right now from DeFiLlama, sorted by APY. *Skip 20 minutes of yield-farm comparison shopping — best stablecoin APYs, sorted, one 5¢ call.* `?limit=1-25`, `?stablecoinOnly=true\|false` |
| `/new-pairs` | $0.05 | New token listings — newest DexScreener pairs with live liquidity, volume, and thin-liquidity flags. *Save an hour of new-listing triage — the newest pairs with liquidity flags, one 5¢ call.* `?limit=1-25`, `?chain=solana\|ethereum\|base` |
| `/gas` | $0.02 | Live gas prices per chain — Base, Ethereum, Solana from public RPCs, with speed tiers where derivable. *10 minutes of RPC polling, done — live gas on Base, Ethereum, and Solana, one 2¢ call.* |
| `/defi` | $0.02 | DeFi protocol intel — top TVL movers, daily fee and revenue leaders, and stablecoin supply flows. From DeFiLlama's free API, agent-ready JSON. *Skip an hour of DeFiLlama tab-hopping — top TVL movers, fee and revenue leaders, stablecoin flows, one 2¢ call.* `?section=movers\|fees\|revenue\|stablecoins`, `?limit=1-25` |
| `/contract-check` | $0.10 | **NOT AN AUDIT —** heuristic screen: Contract safety screen — verification status, proxy and owner-privilege heuristics, holder concentration, and a plain-English risk verdict before you sign. *A 20-minute contract read by hand, done in one 10¢ call.* `?address=0x…` (required), `?chain=base\|ethereum` (default base) |
| `/honeypot` | $0.02 | **NOT AN AUDIT —** heuristic screen: Honeypot screen — simulated sells from real holder wallets, transfer-tax and blacklist flags. Verdict: safe, suspicious, or honeypot. *Don't buy the honeypot — one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/honeypot-check` | $0.10 | **NOT AN AUDIT —** heuristic screen: **Premium** honeypot screen — DEX buy/sell flow (sells≈0 with high buys = red flag), holder concentration, and the full contract safety screen combined into one 0-100 honeypot score. *Full honeypot forensics in one 10¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/approval-risk` | $0.02 | **NOT AN AUDIT —** heuristic screen: Wallet approval screen — unlimited token approvals and risky spender contracts flagged, revoke priority list included. Verdict: clean, review, or urgent. *A 15-minute approval review by hand, done in one 2¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/approval-screen` | $0.10 | **NOT AN AUDIT —** heuristic screen: Approval screen — live token allowances against known spender contracts, unlimited approvals flagged with a revoke priority list. *See what your wallet lets contracts do — one 10¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/rug-score` | $0.02 | **NOT AN AUDIT —** heuristic screen: Rug-pull risk score 0-100 — LP burn status, holder concentration, mint authority, ownership, sell pressure, one-line verdict. *A 20-minute rug-check by hand, done in one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/receipt-check` | $0.02 | "Did it land?" settlement verification — transaction status, confirmations, value moved, decoded token transfers. Verdict: settled, pending, failed, or not-found. *Stop wondering if it landed — one 2¢ call.* `?tx=0x…` (required, tx hash or Solana signature), `?chain=base\|ethereum\|solana` (default base) |
| `/preflight` | $0.05 | **NOT AN AUDIT —** heuristic screen: The full policy in one call — honeypot screen, rug-pull score, and contract safety screen, plus the wallet approval screen when you pass `?wallet=`. One overall verdict: **cleared for takeoff**, **proceed with caution**, or **do not touch**. *Every check that matters, one 5¢ call — don't get rugged.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base), `?wallet=0x…` (optional) |
| `/egress-audit` | $0.10 | **NOT AN AUDIT —** heuristic screen: **The decontamination shower at the airlock** — paste your agent's outbound request log (JSON: url, method, body_snippet) plus an optional declared-endpoint manifest, and get leaked workspace content, embedded secrets, and undeclared endpoints flagged, with declared-vs-actual endpoint analysis. Verdict: **EXFILTRATION_RISK**, **REVIEW**, or **CLEAN**. *Your agent's outbound requests are an unaudited data pipeline — audit it before it leaks.* `?log=<urlencoded JSON>` (required), `?manifest=<urlencoded JSON {endpoints: [...]}>` (optional) |
| `/cron-watch` | $0.05 | **Silent-death watcher for scheduled agent jobs** — submit job history (name, cadence, run timestamps, last success) and get gap analysis, stale flags, a **SILENT_DEATH_RISK** score per job, and recommended checks. *Catch the job that died Tuesday before someone asks where the report is.* `?jobs=<urlencoded JSON array>` (required) |
| `/caveat-check` | $0.05 | **NOT AN AUDIT —** heuristic screen: **The caveat-drop checker** — paste a finding plus its source text (text only, no URL fetching) and get the dropped caveats flagged: numbers missing a baseline, claims missing a measurer, results missing conditions or versions — quoting the exact claim text. *Agent summaries drop ~1.4 caveats per paper — get them back.* `?finding=<claim text>` (required), `?source=<source text>` (required) |
| `/airlock` | $0.10 | **NOT AN AUDIT —** heuristic screen: **Re-entry decontamination scan** — paste inbound content your agent is about to ingest (web page, tool output, file) and get prompt-injection, hidden-instruction, encoded-payload, and exfiltration patterns flagged *before* it touches your context. Verdict: **CLEAN**, **REVIEW**, or **CONTAMINATED**. *Body armor for your agent's context — one 10¢ call.* `?content=<text to scan>` (required, max 50KB), `?source=<label>` (optional) |
| `/tripwire` | $0.05 | **Watch-and-ping for agents** — plant a tripwire on a wallet's USDC balance (Base), a token's USD price, or a wallet's activity, and your webhook gets woken up the moment it crosses your threshold. One 5¢ call arms it for 7 days, fires once. *Stop polling — get tapped on the shoulder.* `?watch_type=wallet_balance\|token_price\|wallet_activity` (required), `?target=0x…` (required), `?condition=above\|below` (required), `?threshold=<number>` (required), `?webhook_url=https://…` (required, https only), `?label=<text>` (optional). Status is a free `GET /tripwire/status?id=<watch_id>` |
| `/escrow` | $0.05 | **LIVE on Base mainnet — agent-to-agent escrow** — mint a deal and get the exact sign-ready calldata: buyer locks real USDC in the escrow contract (`0x6b290f88b49eC73d954f05423a7F17020C5fDB70`), seller delivers off-chain, buyer releases (99% seller, 1% toll-wallet fee) or anyone refunds after the timeout. Non-custodial: this lane never touches funds; no admin keys, no upgradeability. Minimal contract, NOT audited — verified with a live $0.01 mainnet deal. *Stop trusting strangers with handshake deals.* `GET /escrow?action=create&seller=0x…` (required), `&amount_usd=1.5` (required), `&timeout_hours=48` (required, 1–720), `&job=<label>` (optional) mints the deal; `GET /escrow?action=status&job_id=0x…` reads it on-chain. Terms are a free `GET /escrow/terms`. |
| `/audit-prep` | $1.00 | **NOT AN AUDIT —** automated pre-audit review: **The $1 pre-audit** — verified source from Sourcify (free, no key), deterministic static battery (reentrancy patterns, access control, tx.origin, delegatecall, selfdestruct, unprotected initializers, proxy/upgradeability resolution, OpenZeppelin master drift, single-admin centralization), plus three ready-to-run adversarial review prompts (the Attacker, the Economist, the Pedant) for your own model, plus what a human auditor should still check. Unverified contracts get an honest refusal, not a faked review. *The cheapest way to make the real audit cheaper.* `GET /audit-prep?address=0x…` (required), `&chain=base` (base or ethereum). |
| `/tool-gate` | $0.10 | **Policy decision API for pre-execution tool gating** — submit a tool name + args + your policy and get a structured **ALLOW** / **DENY** / **MODIFY** (with rewritten args) decision, structured reasons, and audit metadata. Heuristic policy decision, not a security guarantee — policy quality is the caller's responsibility. *A decision point between agent intent and tool execution.* `?tool=<name>` (required), `?args=<urlencoded JSON>` (required), `?policy=<urlencoded JSON>` (optional) |
| `/verdict` | $0.10 | **NOT AN AUDIT —** heuristic screen: **The flagship one-verdict lane** — the full pre-transaction battery (honeypot, rug-pull, and contract screens, plus the wallet approval screen when you pass `?wallet=`) compressed into one machine-readable verdict: **PROCEED**, **CAUTION**, or **DO_NOT_PROCEED**. Branch on it in code. *One call, one verdict — don't move money without it.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base), `?wallet=0x…` (optional) |
| `/tx-dryrun` | $0.02 | **NOT AN AUDIT —** heuristic screen: The crystal ball — simulate any transaction before signing and get a plain-words explanation of what it does to your wallet. Verdict: **safe**, **review-carefully**, or **do-not-sign**. *Don't sign blind — one 2¢ call.* `?to=0x…` (required), `?data=0x…` (required), `?from=0x…` (required), `?value=0` (optional, wei), `?chain=base\|ethereum` (default base) |
| `/tx-simulate` | $0.10 | **NOT AN AUDIT —** heuristic screen: **Precision** transaction dry-run — `eth_call` + `estimateGas` against live public RPCs: would-succeed vs would-revert verdict, the revert reason decoded from the chain, gas estimate in native currency and USD. Simulation, not a guarantee. *Rehearse the transaction before you send it — one 10¢ call.* `?to=0x…` (required), `?data=0x…` (required), `?from=0x…` (required), `?value=0` (optional, wei), `?chain=base\|ethereum` (default base) |
| `/tx-plain-english` | $0.10 | **NOT AN AUDIT —** heuristic screen: Raw transaction decoder — paste a raw signed tx, get a plain-English explanation of what it moves and where, with common contract calls decoded. Decodes intent, does not simulate. *Read the tx before you sign it — one 10¢ call.* `?tx=0x…` (required, raw signed tx), `?chain=base\|ethereum` (default base) |
| `/permit-scan` | $0.02 | **NOT AN AUDIT —** heuristic screen: The invisible drainer check — Permit2/Seaport interaction exposure plus the standard approval screen, revoke priority list included. Verdict: **clean**, **exposed**, or **urgent**. *The approvals you can't see — one 2¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/airdrop-verdict` | $0.02 | **NOT AN AUDIT —** heuristic screen: Legit or drainer — static page forensics on an airdrop claim URL: lookalike-domain detection, pressure-language flags, the page's contracts run through our own contract screen. Heavily heuristic. Verdict: **likely-legit**, **suspicious**, or **likely-drainer**. *Claim or drainer? One 2¢ call.* `?url=https://…` (required) |
| `/deployer-history` | $0.02 | **NOT AN AUDIT —** heuristic screen: Who made this token — trace the deployer and investigate what else they launched: verification, scam flags, dead-contract patterns. Verdict: **clean**, **mixed**, or **serial-rugger**. *Know who you're trusting — one 2¢ call.* `?address=0x…` (required, token contract), `?chain=base\|ethereum` (default base) |
| `/wallet-check` | $0.05 | Wallet dossier — wallet age (first transaction), transaction count, native balance, first funding source, and bot-likelihood heuristics (young age, high velocity, zero balance, contract funding). Heuristic dossier, not a verdict on intent. *Know the wallet before you trust it — one 5¢ call.* `?address=0x…` (required, wallet), `?chain=base\|ethereum` (default base) |
| `/wallet-watch` | $0.02 | Has anything changed — stateful wallet monitoring. Set a baseline, pass it back later, get a plain-words diff of approvals, balances, and exposure. Verdict: **baseline**, **no-changes**, or **changed**. *Your wallet, watched — one 2¢ call.* `?wallet=0x…` (required), `?chain=base\|ethereum` (default base), `?prev_state=…` (optional — the ready-to-paste `prev_state` value from a previous response) |
| `/site-watch` | $0.05 | Stateless page change detection — sha256 fingerprint of any URL with a compact diff when it changes. Nothing stored on the bridge: pass the hash back on the next call. *Watch any page for changes — one 5¢ call.* `?url=https://…` (required), `?prev_hash=abc123` (optional), `?prev_text=…` or `?prev_text_b64=…` (optional, for a diff snippet) |
| `/terms-tldr` | $0.02 | Terms TL;DR — extractive digest of any terms/bounty/rules page: deadlines, prize amounts, requirements, and gotcha clauses (arbitration, auto-renewal, non-refundable), each with the source snippet. Keyword extraction, not legal advice. *Skip reading the fine print — one 2¢ call.* `?url=https://…` (required) |
| `/skill-scan` | $0.10 | **NOT AN AUDIT —** heuristic screen: Skill supply-chain scan — fetch a skill's SKILL.md and screen it for prompt-injection, credential theft, and exfiltration patterns before you install it. Verdict: **clean**, **suspicious**, or **dangerous**, with findings. *Don't install a malicious skill — one 10¢ call.* `?url=https://…/SKILL.md` or `?text=…` |
| `/sec-facts` | $0.05 | Company facts from the source — revenue, net income, assets, and EPS for any US-listed ticker, 5 annual + 4 quarterly periods, straight from SEC EDGAR companyfacts. No estimates, no hallucination. *Skip the earnings guesswork — one 5¢ call.* `?ticker=AAPL` (required) |
| `/code-run` | $0.05 | Sandboxed JS execution — run a JavaScript snippet in an isolated child process (64MB heap cap, no network, no filesystem) and get the result plus captured logs. Pragmatic sandbox, not a hardened enclave. *Need a quick computation? One 5¢ call.* `?code=…` (required, max 50KB), `?timeout_ms=…` (optional, 1000–10000), `?max_output_chars=…` (optional) |
| `/sage` | $0.05 | Specialist in all fields — ask anything and get a cited, cross-checked brief: US tickers answered from SEC EDGAR filings, crypto tokens from DeFiLlama spot + DEX venue consensus (price, liquidity, volume, momentum), everything else from Wikipedia with references. Confidence verdict: **consensus**, **single-source**, or **conflicting**. Multi-source brief, not a guarantee. *Make any agent the specialist — one 5¢ call.* `?q=…` (required, also accepts `?topic=`, max 200 chars) |
| `/scam-scan` | $5.00 | **NOT AN AUDIT —** heuristic screen: Scam smell-test for money opportunities — fetch a bounty/arena/airdrop/gig/investment listing and get a 10-flag checklist with evidence quotes, extracted prize vs. cost amounts, the prize-pool math, and a verdict: **clean**, **caution**, or **likely-scam**. *Legit bounty? We scan for scams so you don't waste money on a rushed decision — cheaper than one mistake.* `?url=https://…` (required, public listing URL) |
| `/scam-scan-subscribe` | $30.00 | The /scam-scan subscription — one $30 USDC payment on Base buys 30 days of scam scans. Your payment's tx hash is the pass: call `/scam-scan?url=…&sub=<txhash>`. *Subscribe once, scan for a month.* Cancel anytime — nothing auto-renews. |
| `/scrape` | $0.02 | Page-to-text scraper — fetch any public page and get clean readable text, title, and links as JSON. Optional `?crawl=1` follows same-origin links (up to 10 pages). Honest fetch, not a JS renderer. *Skip the HTML wrestling.* `?url=https://…` (required) |
| `/grants` | $0.02 | Federal grant finder — search live Grants.gov opportunities by keyword: title, agency, close date, award ceiling. Live federal data, not a guarantee of eligibility. *Free money has a search box.* `?keyword=solar` (required) |
| `/quant` | $0.02 | Quant-desk math in one call — Black-Scholes pricing with Greeks, parametric VaR, Sharpe ratio, compound growth. Textbook math, not financial advice. `?op=black-scholes&S=100&K=100&T=1&r=0.05&sigma=0.2&side=call` |
| `/secret-scan` | $0.02 | **NOT AN AUDIT —** heuristic screen: Leaked-secret sweep — scan a URL or pasted text for exposed AWS keys, GitHub tokens, private keys, and other credentials. Findings redacted, never echoed. *Don't ship a leaked key.* `?url=https://…` or `?text=…` (one required) |
| `/redteam` | $0.10 | **NOT AN AUDIT —** heuristic screen: Prompt red-team screen — score a system prompt against 7 prompt-injection weakness checks, each with a concrete fix. *Harden the prompt before attackers do.* `?prompt=…` (required) |
| `/datasets` | $1.00 | Curated agent datasets — downloadable snapshots: x402 pay-per-call registry, prompt-injection test corpus, MCP price index. Curated snapshot, not live — verify prices before quoting. `?name=x402-registry` (required) |
| `/regulatory-pack` | $0.05 | Regulatory recall lookup — FDA drug and food enforcement recalls by product or firm, straight from openFDA. Unvalidated public data, not medical or legal advice. `?agency=fda&query=ibuprofen` (required) |
| `/road-pack` | $0.05 | The combo meal from Mini's Agent Supply Store — cheapest gas, top token prices with momentum verdicts, DeFi TVL movers, and the AI model shelf, plus a plain-English trip brief, in one call. 8¢ of intel, one 5¢ toll. *Gas, tools, and everything you forgot to pack — one 5¢ call.* `?limit=1–25` (optional, max token prices, default 10) |
| `/models` | $0.02 | x402-payable AI model catalog — every model with per-million-token pricing, free models flagged (catalog data: BlockRun.AI). *Stop guessing what models cost — every x402-payable AI model with per-million-token pricing and the free ones flagged, one 2¢ call.* |
| `/prompt-cost` | $0.02 | Prompt cost estimator — paste a prompt, get a heuristic token estimate and what it would cost across every model in the `/models` catalog, cheapest first. Heuristic estimate, not an exact tokenizer count. *Know the price before you prompt — one 2¢ call.* `?text=…` (required), `?model=…` (optional) |
| `/model-picks` | $0.02 | Best model per dollar — curated quality scores per task (coding, writing, reasoning, chat) joined with live per-token pricing, ranked by value. Quality is a curated benchmark snapshot, not a live measurement. `?task=coding\|writing\|reasoning\|chat` (default chat) |
| `/rpc-speed` | $0.02 | RPC speed test — live latency ranking of public keyless RPC endpoints per chain, fastest first, measured from the bridge. *Stop guessing which RPC is fast — one 2¢ call.* `?chain=base\|ethereum\|solana` (default base) |

> **Parked:** `POST /file-pr` (GitHub PR filing, was $2.00) is **disabled** as of 2026-09-30 — a self-audit found it filed PRs authored as the keeper's personal GitHub account with no throttle. It returns only under a neutral bot identity.

`?limit=N` caps items returned (1–200) on the bounty lanes.

## How to pay (x402 v2)

1. `GET` a lane. Without payment you get **HTTP 402** with the payment requirements
   in the response headers and JSON body — the 402 is the source of truth for the
   exact amount and the payTo address. Two rails — pick either:
   - **Base:** sign the EIP-3009 authorization:
     - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, `/honeypot`, `/approval-risk`, `/rug-score`, `/receipt-check`, `/tx-dryrun`, `/permit-scan`, `/airdrop-verdict`, `/deployer-history`, `/wallet-watch`, `/prompt-cost`, `/model-picks`, `/rpc-speed`, `/terms-tldr`, `/scrape`, `/grants`, `/quant`, `/secret-scan`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, `/new-pairs`, `/preflight`, `/road-pack`, `/site-watch`, `/wallet-check`, `/sec-facts`, `/code-run`, `/regulatory-pack`, and `/sage`; `100000` ($0.10) on `/contract-check`, `/approval-screen`, `/tx-plain-english`, `/honeypot-check`, `/tx-simulate`, `/redteam`, `/skill-scan`, and `/verdict`; `1000000` ($1.00) on `/datasets`; `5000000` ($5.00) on `/scam-scan`; `30000000` ($30.00) on `/scam-scan-subscribe`
     - network: `eip155:8453`
   - **Solana:** sign the SPL `transferChecked` (facilitator sponsors the fee —
     you need USDC only, no SOL):
     - asset: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC on Solana)
     - amount: `20000` ($0.02) on the bounty lanes, `/prices`, `/gas`, `/defi`, `/honeypot`, `/approval-risk`, `/rug-score`, `/receipt-check`, `/tx-dryrun`, `/permit-scan`, `/airdrop-verdict`, `/deployer-history`, `/wallet-watch`, `/prompt-cost`, `/model-picks`, `/rpc-speed`, `/terms-tldr`, `/scrape`, `/grants`, `/quant`, `/secret-scan`, and `/models`; `50000` ($0.05) on `/enrich`, `/token-check`, `/markets`, `/search`, `/yields`, `/new-pairs`, `/preflight`, `/road-pack`, `/site-watch`, `/wallet-check`, `/sec-facts`, `/code-run`, `/regulatory-pack`, and `/sage`; `100000` ($0.10) on `/contract-check`, `/approval-screen`, `/tx-plain-english`, `/honeypot-check`, `/tx-simulate`, `/redteam`, `/skill-scan`, and `/verdict`; `1000000` ($1.00) on `/datasets`; `5000000` ($5.00) on `/scam-scan`; `30000000` ($30.00) on `/scam-scan-subscribe`
     - network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
3. Retry the request with the signed payment in the `X-Payment` header.
   A settled payment returns **HTTP 200** with the lane's JSON.

Burn TrollBridge Fuel (GAS) instead of USDC: 1 GAS per 2¢ lane, 3 GAS per 5¢
lane, 6 GAS per 10¢ protection lane — `GET /fuel` for the price, the contracts,
and how to burn-to-cross.

## Free endpoints (never tolled)

- `GET /tools` — TrollBridge marketplace directory: third-party tools, listing terms
- `GET /traffic` — bridge traffic: 402 challenges vs paid crossings per lane,
  plus an `almost_paid` section: failed payment attempts, repeat challengers,
  and per-visitor funnel stages (discovery → challenged → tried & failed → paid)
- `GET /health` — status, lane count, traffic totals
- `GET /fuel` — TrollBridge Fuel (GAS) price, burn-to-cross instructions, fuel tiers
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
rug-pull scores, contract safety screens, wallet approval screens, settlement
verification, transaction simulation, invisible-drainer scans, claim-page
forensics, deployer forensics, wallet monitoring, and the full /preflight bundle) plus bounty intel (open bounties,
paid verdicts, deadlines), trader intel (prices, wallet enrichment, token
safety scans) with plain-English verdicts, market intel (live prediction-market
odds, agent-ready web search), and DeFi intel (yields, new listings, gas,
protocol flows), plus agent-ops intel (prompt costs, model picks, RPC speed,
terms digests). 2¢ per checkpoint, 5¢ for the value tier, 10¢ for the
protection tier. Honest ledger: traffic is public at `GET /traffic`.
Don't get rugged.
